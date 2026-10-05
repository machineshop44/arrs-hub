import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, ensureDataDirs } from "./config.mjs";
import {
  arrCommand,
  arrConn,
  arrGet,
  fetchArrQueueRecords,
  getJson,
  importedBy,
  qbPost,
  qbSession,
  qbStart,
  queueDownloadIds,
  refreshImportedHashes,
  sabApi,
} from "./download-clients.mjs";
import { appLabel } from "./problems.mjs";
import { runArrPass } from "./stack-autofix.mjs";
import { createServiceUrlResolver } from "./url-policy.mjs";

const DAY_S = 86_400;
const HOUR_MS = 3_600_000;
const QB_REMOVE_MAX_PER_SCAN = 200;
/** Torrent states where qBittorrent is still working on the files. */
const QB_BUSY_STATE = /^(checking|moving|allocating|metaDL|downloading|stalledDL|queuedDL|forcedDL|pausedDL|stoppedDL)/i;
/** SABnzbd failures a second download attempt can fix (servers missing articles, repair short). */
const SAB_RETRYABLE = /article|missing|repair|par2|crc|aborted|cannot be completed|incomplete|unpack/i;
const SAB_NEVER_RETRY = /password|encrypt|disk|space|empty|duplicate|no files|invalid nzb|bad nzb/i;
const SCAN_COMMAND = { sonarr: "DownloadedEpisodesScan", radarr: "DownloadedMoviesScan", lidarr: "DownloadedAlbumsScan" };
const CATEGORY_FIELD = { sonarr: "tvCategory", radarr: "movieCategory", lidarr: "musicCategory" };

/**
 * "td-peers.com = 3.5\ntleechreload.org = 3.5" → [{ match: "td-peers.com", days: 3.5 }, …]
 * @param {string} value
 */
export function parseSeedRules(value) {
  return String(value || "")
    .split(/[\n,;]+/)
    .map((line) => {
      const m = /^\s*([^=:\s]+)\s*[=:]\s*([\d.]+)\s*d?\s*$/i.exec(line);
      if (!m) return null;
      const days = Number(m[2]);
      return Number.isFinite(days) && days >= 0 ? { match: m[1].toLowerCase(), days } : null;
    })
    .filter(Boolean);
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return String(url || "").toLowerCase();
  }
}

/**
 * Decide which finished torrents can go. A torrent is removed only when an *arr
 * imported it, no *arr queue still holds it, and it has seeded long enough for
 * its tracker's rule (trackers without a rule have no minimum).
 * @param {{ hash: string, name: string, state?: string, progress?: number, seeding_time?: number, completion_on?: number, trackers: string[] }[]} torrents
 * @param {{ importedBy: Map<string, string>, activeHashes: Set<string>, rules: { match: string, days: number }[], nowSec: number }} ctx
 */
export function pickQbRemovals(torrents, ctx) {
  const out = [];
  for (const t of torrents || []) {
    const hash = String(t?.hash || "").toLowerCase();
    if (!hash || Number(t.progress) < 1 || QB_BUSY_STATE.test(String(t.state || ""))) continue;
    const app = ctx.importedBy.get(hash);
    if (!app || ctx.activeHashes.has(hash)) continue;
    const hosts = (t.trackers || []).map(hostOf).filter(Boolean);
    if (!hosts.length) continue;
    const rule = ctx.rules
      .filter((r) => hosts.some((h) => h.includes(r.match)))
      .sort((a, b) => b.days - a.days)[0];
    const seededS =
      Number.isFinite(Number(t.seeding_time)) && Number(t.seeding_time) > 0
        ? Number(t.seeding_time)
        : t.completion_on > 0
          ? Math.max(0, ctx.nowSec - Number(t.completion_on))
          : 0;
    const needS = rule ? rule.days * DAY_S : 0;
    if (seededS < needS) continue;
    const seededDays = Math.round((seededS / DAY_S) * 10) / 10;
    out.push({
      hash,
      name: String(t.name || hash),
      app,
      reason: rule
        ? `imported by ${appLabel(app)} · seeded ${seededDays} d (${rule.match} needs ${rule.days} d)`
        : `imported by ${appLabel(app)} · ${hosts[0]} has no seed rule`,
    });
  }
  return out;
}

/**
 * What to resume in SABnzbd. A timed pause ("pause for 30 min") is the user's
 * choice and is left alone; so is a nearly full download disk (SAB pauses itself).
 * @param {{ paused?: boolean, pause_int?: string, diskspace1?: string | number, slots?: { nzo_id: string, status?: string, filename?: string }[] }} queue
 */
export function planSabResume(queue) {
  if (!queue) return { resumeAll: false, items: [], skip: "no queue" };
  if (String(queue.pause_int || "0") !== "0") return { resumeAll: false, items: [], skip: "timed pause set" };
  const freeGb = Number(queue.diskspace1);
  if (Number.isFinite(freeGb) && freeGb < 1) return { resumeAll: false, items: [], skip: "download disk almost full" };
  const items = (queue.slots || []).filter((s) => s?.nzo_id && String(s.status || "").toLowerCase() === "paused");
  return { resumeAll: queue.paused === true, items, skip: "" };
}

/**
 * Failed SABnzbd jobs worth one more try. Never retried twice, never while still queued.
 * @param {{ nzo_id: string, status?: string, fail_message?: string, name?: string }[]} slots
 * @param {Set<string>} queuedIds
 * @param {Set<string>} alreadyRetried
 */
export function pickSabRetries(slots, queuedIds, alreadyRetried) {
  return (slots || []).filter((s) => {
    const msg = String(s?.fail_message || "");
    return (
      s?.nzo_id &&
      String(s.status || "").toLowerCase() === "failed" &&
      !queuedIds.has(s.nzo_id) &&
      !alreadyRetried.has(s.nzo_id) &&
      SAB_RETRYABLE.test(msg) &&
      !SAB_NEVER_RETRY.test(msg)
    );
  });
}

const STATE_FILE = path.join(DATA_DIR, "client-autofix.json");

function loadState() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function saveState(patch) {
  try {
    ensureDataDirs();
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...loadState(), ...patch }, null, 2));
  } catch (err) {
    console.warn("[client-autofix] could not save state:", err instanceof Error ? err.message : err);
  }
}

function fixResult(now, fields) {
  return { blocklist: false, keptSeeding: false, at: new Date(now).toISOString(), ok: true, ...fields };
}

function errText(err) {
  return err instanceof Error ? err.message : String(err);
}

async function runSabPass(resolver, settings, now) {
  const api = sabApi(resolver);
  if (!api) return [];
  const results = [];
  const queue = (await getJson(api({ mode: "queue" })))?.queue;

  if (settings.autoFixSabResume !== false) {
    const plan = planSabResume(queue);
    if (!plan.skip && (plan.resumeAll || plan.items.length)) {
      const base = { key: "sab:queue", app: "sabnzbd", rule: "sabResume", title: plan.items.length === 1 ? String(plan.items[0].filename || "Queue") : "Queue" };
      try {
        if (plan.resumeAll) await getJson(api({ mode: "resume" }));
        for (const s of plan.items) await getJson(api({ mode: "queue", name: "resume", value: s.nzo_id }));
        const parts = [];
        if (plan.resumeAll) parts.push("queue was paused");
        if (plan.items.length) parts.push(`${plan.items.length} paused item${plan.items.length === 1 ? "" : "s"}`);
        results.push(fixResult(now, { ...base, reason: `resumed (${parts.join(", ")})` }));
      } catch (err) {
        results.push(fixResult(now, { ...base, reason: "resume", ok: false, error: errText(err) }));
      }
    }
  }

  if (settings.autoFixSabRetry !== false) {
    const history = (await getJson(api({ mode: "history", failed_only: "1", limit: "50" })))?.history;
    const retried = new Set(loadState().sabRetried || []);
    const queuedIds = new Set((queue?.slots || []).map((s) => s?.nzo_id).filter(Boolean));
    for (const s of pickSabRetries(history?.slots, queuedIds, retried)) {
      retried.add(s.nzo_id);
      const base = { key: `sab:${s.nzo_id}`, app: "sabnzbd", rule: "sabRetry", title: String(s.name || s.nzo_id) };
      try {
        await getJson(api({ mode: "retry", value: s.nzo_id }));
        results.push(fixResult(now, { ...base, reason: `retried once (${String(s.fail_message).slice(0, 80)})` }));
      } catch (err) {
        results.push(fixResult(now, { ...base, reason: "retry", ok: false, error: errText(err) }));
      }
    }
    saveState({ sabRetried: [...retried].slice(-500) });
  }
  return results;
}

/** qBittorrent category → *arr app, read from each app's qBittorrent download-client settings. */
async function categoryApps(resolver) {
  const map = new Map();
  await Promise.all(
    Object.entries(CATEGORY_FIELD).map(async ([app, field]) => {
      const conn = arrConn(resolver, app);
      if (!conn) return;
      try {
        const clients = await arrGet(conn, "/downloadclient");
        for (const c of Array.isArray(clients) ? clients : []) {
          if (!/qbittorrent/i.test(String(c?.implementation || ""))) continue;
          const cat = (c.fields || []).find((f) => f?.name === field)?.value;
          if (cat) map.set(String(cat).toLowerCase(), app);
        }
      } catch {
        /* unknown categories are skipped */
      }
    }),
  );
  return map;
}

async function runQbPass(resolver, settings, now) {
  const session = await qbSession(resolver);
  if (!session) return [];
  const [, queues] = await Promise.all([refreshImportedHashes(resolver), fetchArrQueueRecords(resolver)]);
  if (!queues) throw new Error("an *arr queue could not be read");
  const activeHashes = queueDownloadIds(queues);
  const list = await getJson(`${session.base}/api/v2/torrents/info`, session.headers, 30_000);
  const torrents = Array.isArray(list) ? list : [];
  const nowSec = Math.floor(now / 1000);
  const results = [];

  if (settings.qbCleanupEnabled !== false && importedBy.size) {
    const candidates = torrents.filter((t) => {
      const h = String(t?.hash || "").toLowerCase();
      return importedBy.has(h) && !activeHashes.has(h);
    });
    for (const t of candidates) {
      t.trackers = t.tracker ? [t.tracker] : [];
      if (t.trackers.length) continue;
      try {
        const rows = await getJson(`${session.base}/api/v2/torrents/trackers?hash=${t.hash}`, session.headers);
        t.trackers = (Array.isArray(rows) ? rows : []).map((r) => String(r?.url || "")).filter((u) => /^(https?|udp):\/\//i.test(u));
      } catch {
        t.trackers = [];
      }
    }
    const picks = pickQbRemovals(candidates, {
      importedBy,
      activeHashes,
      rules: parseSeedRules(settings.qbSeedRules),
      nowSec,
    }).slice(0, QB_REMOVE_MAX_PER_SCAN);
    if (picks.length) {
      const deleteFiles = settings.qbCleanupDeleteFiles !== false;
      let error = "";
      try {
        await qbPost(session, "torrents/delete", { hashes: picks.map((p) => p.hash).join("|"), deleteFiles: String(deleteFiles) });
        for (const p of picks) importedBy.delete(p.hash);
      } catch (err) {
        error = errText(err);
      }
      for (const p of picks) {
        results.push(
          fixResult(now, {
            key: `qb:${p.hash}`,
            app: "qbittorrent",
            title: p.name,
            rule: "qbCleanup",
            reason: `${p.reason}${deleteFiles ? "" : " · files kept"}`,
            ok: !error,
            ...(error ? { error } : {}),
          }),
        );
      }
    }
  }

  if (settings.autoFixQbRecheck !== false) {
    const missing = torrents.filter((t) => String(t?.state) === "missingFiles");
    if (missing.length) {
      const hashes = missing.map((t) => t.hash).join("|");
      const base = { key: "qb:missingFiles", app: "qbittorrent", rule: "qbRecheck", title: missing.length === 1 ? String(missing[0].name) : `${missing.length} torrents` };
      try {
        await qbPost(session, "torrents/recheck", { hashes });
        await qbStart(session, hashes);
        results.push(fixResult(now, { ...base, reason: "files reported missing → rechecked and resumed" }));
      } catch (err) {
        results.push(fixResult(now, { ...base, reason: "recheck", ok: false, error: errText(err) }));
      }
    }
  }

  if (settings.autoFixQbSlots !== false) {
    try {
      const prefs = await getJson(`${session.base}/api/v2/app/preferences`, session.headers);
      const max = Number(prefs?.max_active_downloads);
      const stalled = torrents.filter((t) => t?.state === "stalledDL" && !Number(t.dlspeed)).length;
      const waitingWithSeeds = torrents.some((t) => t?.state === "queuedDL" && Number(t.num_seeds) > 0);
      if (prefs?.queueing_enabled !== false && prefs?.dont_count_slow_torrents === false && max > 0 && stalled >= max && waitingWithSeeds) {
        await qbPost(session, "app/setPreferences", { json: JSON.stringify({ dont_count_slow_torrents: true }) });
        results.push(
          fixResult(now, {
            key: "qb:slots",
            app: "qbittorrent",
            rule: "qbSlots",
            title: "Download slots",
            reason: `${stalled} dead torrents filled all ${max} active slots while others waited → turned on "Do not count slow torrents"`,
          }),
        );
      }
    } catch (err) {
      console.warn("[client-autofix] qBittorrent slots:", errText(err));
    }
  }

  if (settings.autoFixQbReannounce !== false) {
    const stuck = torrents.filter((t) => (t?.state === "stalledDL" || t?.state === "metaDL") && !Number(t.dlspeed));
    if (stuck.length) {
      try {
        await qbPost(session, "torrents/reannounce", { hashes: stuck.map((t) => t.hash).join("|") });
        results.push(
          fixResult(now, {
            key: "qb:reannounce",
            app: "qbittorrent",
            rule: "qbReannounce",
            title: stuck.length === 1 ? String(stuck[0].name) : `${stuck.length} stalled torrents`,
            reason: "asked the trackers for peers again",
          }),
        );
      } catch (err) {
        console.warn("[client-autofix] qBittorrent reannounce:", errText(err));
      }
    }
  }

  if (settings.autoFixScanUnimported !== false) {
    const cats = await categoryApps(resolver);
    const unimported = torrents.filter((t) => {
      const h = String(t?.hash || "").toLowerCase();
      const ageS = nowSec - Number(t?.completion_on || 0);
      return (
        Number(t?.progress) >= 1 &&
        t.content_path &&
        cats.has(String(t.category || "").toLowerCase()) &&
        ageS >= 20 * 60 &&
        ageS <= 2 * DAY_S &&
        !activeHashes.has(h) &&
        !importedBy.has(h)
      );
    });
    for (const t of unimported.slice(0, 10)) {
      const app = cats.get(String(t.category).toLowerCase());
      const conn = arrConn(resolver, app);
      const base = { key: `qb:scan:${t.hash}`, app, rule: "scanUnimported", title: String(t.name) };
      try {
        await arrCommand(conn, { name: SCAN_COMMAND[app], path: t.content_path, downloadClientId: String(t.hash).toUpperCase(), importMode: "Auto" });
        const hours = Math.round((nowSec - Number(t.completion_on)) / 360) / 10;
        results.push(fixResult(now, { ...base, reason: `finished ${hours} h ago but never imported → asked ${appLabel(app)} to scan it` }));
      } catch (err) {
        results.push(fixResult(now, { ...base, reason: "scan", ok: false, error: errText(err) }));
      }
    }
  }
  return results;
}

/**
 * Download-client and *arr housekeeping. Each group runs at most once per
 * `clientAutoFixIntervalHours` (default daily) so the *arrs get time to work
 * between passes; a group that can't reach its app is retried next scan.
 * @param {Record<string, unknown>} settings monitor settings
 * @param {{ resolver?: object, now?: number, force?: boolean, snapshot?: object }} [deps]
 */
export async function runClientAutoFix(settings, deps = {}) {
  if (settings.autoFixEnabled === false) return [];
  const resolver = deps.resolver || createServiceUrlResolver({ urls: {} });
  const now = deps.now ?? Date.now();
  const intervalMs = Math.max(1, Number(settings.clientAutoFixIntervalHours) || 24) * HOUR_MS;
  const lastRuns = loadState();
  const due = (group) => deps.force || !(now - (Date.parse(lastRuns[group]) || 0) < intervalMs);
  const passes = [
    ["sabnzbd", () => runSabPass(resolver, settings, now)],
    ["qbittorrent", () => runQbPass(resolver, settings, now)],
    ["arrs", () => runArrPass(resolver, settings, now, deps.snapshot)],
  ];
  const results = [];
  for (const [group, run] of passes) {
    if (!due(group)) continue;
    try {
      results.push(...(await run()));
      saveState({ [group]: new Date(now).toISOString() });
    } catch (err) {
      // Not marked done: retried next scan (e.g. downloader PC was rebooting).
      console.warn(`[client-autofix] ${group}:`, errText(err));
    }
  }
  return results;
}
