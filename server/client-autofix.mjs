import fs from "node:fs";
import path from "node:path";
import { getArrApiKey } from "./arr-api-keys.mjs";
import { DATA_DIR, ensureDataDirs } from "./config.mjs";
import { loadIntegrationsSettings } from "./integrations.mjs";
import { appLabel, arrApiVersion, qbLogin } from "./problems.mjs";
import { createServiceUrlResolver } from "./url-policy.mjs";

const DAY_S = 86_400;
const HOUR_MS = 3_600_000;
/** Apps whose history proves a download was imported, with the history event that means "imported". */
const IMPORT_HISTORY = {
  sonarr: { eventType: 3, names: ["downloadFolderImported"] },
  radarr: { eventType: 3, names: ["downloadFolderImported"] },
  lidarr: { eventType: 8, names: ["downloadImported"] },
};
const QB_REMOVE_MAX_PER_SCAN = 200;
/** Torrent states where qBittorrent is still working on the files. */
const QB_BUSY_STATE = /^(checking|moving|allocating|metaDL|downloading|stalledDL|queuedDL|forcedDL|pausedDL|stoppedDL)/i;

function normalizeBase(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

async function getJson(url, headers = {}, timeoutMs = 15_000) {
  const res = await fetch(url, {
    headers: { Accept: "application/json", ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ""}`);
  return text ? JSON.parse(text) : null;
}

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

async function runSabResume(resolver, now) {
  const base = normalizeBase(resolver.resolve("sabnzbd")).replace(/\/sabnzbd\/?$/i, "");
  const apiKey = loadIntegrationsSettings().sabnzbd?.apiKey || "";
  if (!base || !apiKey) return [];
  const api = (params) =>
    `${base}/sabnzbd/api?${new URLSearchParams({ output: "json", apikey: apiKey, ...params })}`;
  const data = await getJson(api({ mode: "queue" }));
  const plan = planSabResume(data?.queue);
  if (plan.skip || (!plan.resumeAll && !plan.items.length)) return [];

  const base0 = { key: "sab:queue", app: "sabnzbd", rule: "sabResume", blocklist: false, keptSeeding: false, at: new Date(now).toISOString() };
  try {
    if (plan.resumeAll) await getJson(api({ mode: "resume" }));
    for (const s of plan.items) await getJson(api({ mode: "queue", name: "resume", value: s.nzo_id }));
    const parts = [];
    if (plan.resumeAll) parts.push("queue was paused");
    if (plan.items.length) parts.push(`${plan.items.length} paused item${plan.items.length === 1 ? "" : "s"}`);
    return [{ ...base0, title: plan.items.length === 1 ? String(plan.items[0].filename || "Queue") : "Queue", reason: `resumed (${parts.join(", ")})`, ok: true }];
  } catch (err) {
    return [{ ...base0, title: "Queue", reason: "resume", ok: false, error: err instanceof Error ? err.message : String(err) }];
  }
}

/** Hashes each *arr has imported (lower-case) → app id. Kept across passes; history is paged newest-first. */
const importedBy = new Map();

async function refreshImportedHashes(resolver) {
  const pageSize = 2000;
  await Promise.all(
    Object.entries(IMPORT_HISTORY).map(async ([app, ev]) => {
      const base = normalizeBase(resolver.resolve(app));
      const apiKey = getArrApiKey(app);
      if (!base || !apiKey) return;
      try {
        const qs = new URLSearchParams({ page: "1", pageSize: String(pageSize), sortKey: "date", sortDirection: "descending", eventType: String(ev.eventType) });
        const data = await getJson(`${base}/api/${arrApiVersion(app)}/history?${qs}`, { "X-Api-Key": apiKey }, 30_000);
        const records = Array.isArray(data?.records) ? data.records : [];
        for (const r of records) {
          const type = r?.eventType;
          if (typeof type === "string" && !ev.names.includes(type)) continue;
          if (typeof type === "number" && type !== ev.eventType) continue;
          const id = String(r?.downloadId || "").toLowerCase();
          if (id) importedBy.set(id, app);
        }
      } catch {
        /* that app's imports just aren't known this pass */
      }
    }),
  );
}

/** Every download id still in an *arr queue. Null when any configured queue can't be read. */
async function activeQueueHashes(resolver) {
  const out = new Set();
  const results = await Promise.all(
    ["sonarr", "radarr", "lidarr", "readarr", "whisparr"].map(async (app) => {
      const base = normalizeBase(resolver.resolve(app));
      const apiKey = getArrApiKey(app);
      if (!base || !apiKey) return true;
      try {
        const data = await getJson(
          `${base}/api/${arrApiVersion(app)}/queue?page=1&pageSize=1000&includeUnknownSeriesItems=true&includeUnknownMovieItems=true`,
          { "X-Api-Key": apiKey },
          30_000,
        );
        for (const r of Array.isArray(data?.records) ? data.records : []) {
          const id = String(r?.downloadId || "").toLowerCase();
          if (id) out.add(id);
        }
        return true;
      } catch {
        return false;
      }
    }),
  );
  return results.every(Boolean) ? out : null;
}

async function runQbCleanup(resolver, settings, now) {
  const integrations = loadIntegrationsSettings();
  const base = normalizeBase(resolver.resolve("qbittorrent"));
  const { username, password } = integrations.qbittorrent || {};
  if (!base || (!username && !password)) return [];

  const [, activeHashes] = await Promise.all([refreshImportedHashes(resolver), activeQueueHashes(resolver)]);
  if (!activeHashes) throw new Error("an *arr queue could not be read");
  if (!importedBy.size) return [];

  const headers = await qbLogin(base, username, password);
  const list = await getJson(`${base}/api/v2/torrents/info?filter=completed`, headers, 30_000);
  const candidates = (Array.isArray(list) ? list : []).filter((t) => {
    const h = String(t?.hash || "").toLowerCase();
    return importedBy.has(h) && !activeHashes.has(h);
  });
  for (const t of candidates) {
    t.trackers = t.tracker ? [t.tracker] : [];
    if (!t.trackers.length) {
      try {
        const rows = await getJson(`${base}/api/v2/torrents/trackers?hash=${t.hash}`, headers);
        t.trackers = (Array.isArray(rows) ? rows : []).map((r) => String(r?.url || "")).filter((u) => /^(https?|udp):\/\//i.test(u));
      } catch {
        t.trackers = [];
      }
    }
  }
  const picks = pickQbRemovals(candidates, {
    importedBy,
    activeHashes,
    rules: parseSeedRules(settings.qbSeedRules),
    nowSec: Math.floor(now / 1000),
  }).slice(0, QB_REMOVE_MAX_PER_SCAN);
  if (!picks.length) return [];

  const at = new Date(now).toISOString();
  const deleteFiles = settings.qbCleanupDeleteFiles !== false;
  const body = new URLSearchParams({ hashes: picks.map((p) => p.hash).join("|"), deleteFiles: String(deleteFiles) });
  let error = "";
  try {
    const res = await fetch(`${base}/api/v2/torrents/delete`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded", Referer: base },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) error = `qBittorrent delete failed (HTTP ${res.status})`;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  for (const p of picks) if (!error) importedBy.delete(p.hash);
  return picks.map((p) => ({
    key: `qb:${p.hash}`,
    app: "qbittorrent",
    title: p.name,
    rule: "qbCleanup",
    reason: `${p.reason}${deleteFiles ? "" : " · files kept"}`,
    blocklist: false,
    keptSeeding: false,
    at,
    ok: !error,
    ...(error ? { error } : {}),
  }));
}

const STATE_FILE = path.join(DATA_DIR, "client-autofix.json");

/** @returns {Record<string, string>} client id → ISO time of its last completed pass */
function loadLastRuns() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function saveLastRun(client, now) {
  try {
    ensureDataDirs();
    const runs = { ...loadLastRuns(), [client]: new Date(now).toISOString() };
    fs.writeFileSync(STATE_FILE, JSON.stringify(runs, null, 2));
  } catch (err) {
    console.warn("[client-autofix] could not save last run:", err instanceof Error ? err.message : err);
  }
}

/**
 * Download-client housekeeping: resume paused SABnzbd items and clear finished,
 * imported torrents from qBittorrent once their tracker's seed time is met.
 * Runs at most once per `clientAutoFixIntervalHours` (default daily) so the
 * *arrs get time to work between passes.
 * @param {Record<string, unknown>} settings monitor settings
 */
export async function runClientAutoFix(settings, deps = {}) {
  if (settings.autoFixEnabled === false) return [];
  if (settings.autoFixSabResume === false && settings.qbCleanupEnabled === false) return [];
  const resolver = deps.resolver || createServiceUrlResolver({ urls: {} });
  const now = deps.now ?? Date.now();
  const intervalMs = Math.max(1, Number(settings.clientAutoFixIntervalHours) || 24) * HOUR_MS;
  const lastRuns = loadLastRuns();
  const due = (client) => deps.force || !(now - (Date.parse(lastRuns[client]) || 0) < intervalMs);
  const passes = [
    ["sabnzbd", settings.autoFixSabResume !== false, () => runSabResume(resolver, now)],
    ["qbittorrent", settings.qbCleanupEnabled !== false, () => runQbCleanup(resolver, settings, now)],
  ];
  const results = [];
  for (const [client, enabled, run] of passes) {
    if (!enabled || !due(client)) continue;
    try {
      results.push(...(await run()));
      saveLastRun(client, now);
    } catch (err) {
      // Not marked done: retried next scan (e.g. downloader PC was rebooting).
      console.warn(`[client-autofix] ${client}:`, err instanceof Error ? err.message : err);
    }
  }
  return results;
}
