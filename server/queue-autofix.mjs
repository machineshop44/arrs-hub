import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, ensureDataDirs } from "./config.mjs";
import { appLabel } from "./problems.mjs";
import { removeArrQueueItem } from "./queue-actions.mjs";
import { AUTO_IMPORT_APPS, autoImportDownload, needsManualImport } from "./queue-autoimport.mjs";

/** Extensions that never belong in a media release. */
const DANGEROUS_EXT = /\.(exe|lnk|scr|bat|cmd|vbs|vbe|msi|pif|ps1|jar|arj|hta|wsf)\b/i;
const DANGEROUS_MSG = /dangerous|unwanted (file )?extension|executable/i;
const SAMPLE_MSG = /\bsample\b|no files found (are )?eligible|no (video|audio|media) files/i;
/**
 * Path / permission / disk / client-connectivity problems: the release is fine,
 * the setup isn't. Never blocklist or remove over these (DrivePool balancing,
 * Surfshark reconnects, full disk).
 */
const NEVER_REMOVE_MSG =
  /remote path|does not appear to exist|not a valid (windows )?path|access to the path|permission|denied|not enough (free )?space|disk is full|i\/o error|connection refused|timed out|unable to communicate|unavailable due to failures/i;
const NOT_UPGRADE_MSG =
  /not an upgrade|not a custom format upgrade|already imported|existing file .*(better|same)|has a (better|same) (quality|custom format)|already (exists|has a file)/i;

/**
 * Pick the auto-fix for a stuck queue item, or null when a human should look
 * (manual import / unparseable / unmatched series).
 * @param {{ errorMessage?: string, status?: string, trackedDownloadState?: string }} issue
 * @param {Record<string, unknown>} settings monitor settings
 * @returns {{ rule: "dangerous" | "sample" | "notUpgrade" | "failed", blocklist: boolean, reason: string } | null}
 */
export function classifyQueueIssue(issue, settings) {
  const msg = String(issue?.errorMessage || "");
  const state = String(issue?.trackedDownloadState || "").toLowerCase();
  const status = String(issue?.status || "").toLowerCase();
  if (NEVER_REMOVE_MSG.test(msg) || status === "downloadclientunavailable") return null;

  if (settings.autoFixDangerous !== false && (DANGEROUS_MSG.test(msg) || DANGEROUS_EXT.test(msg))) {
    const ext = DANGEROUS_EXT.exec(msg)?.[0]?.toLowerCase();
    return { rule: "dangerous", blocklist: true, reason: `unwanted file${ext ? ` (${ext})` : ""}` };
  }
  if (settings.autoFixSample !== false && SAMPLE_MSG.test(msg)) {
    return { rule: "sample", blocklist: true, reason: "sample / no importable files" };
  }
  if (settings.autoFixNotUpgrade !== false && NOT_UPGRADE_MSG.test(msg)) {
    return { rule: "notUpgrade", blocklist: false, reason: "not an upgrade / already imported" };
  }
  if (
    settings.autoFixFailed !== false &&
    (state === "failed" || state === "failedpending" || status === "failed")
  ) {
    return { rule: "failed", blocklist: true, reason: "download failed" };
  }
  return null;
}

/**
 * Same episode (Sonarr) or movie (Radarr) grabbed by more than one download:
 * keep a healthy copy over a stalled / warning one, then the highest resolution,
 * then highest custom format score, then the one closest to done.
 * Season packs are never removed (they carry other episodes).
 * @param {string} app
 * @param {{ id: number, title: string, downloadId: string, episodeId?: number | null, movieId?: number | null, resolution: number, customFormatScore: number, sizeleft: number, indexer?: string, protocol?: string }[]} records
 * @returns {{ loser: object, winner: object }[]}
 */
export function pickDuplicateLosers(app, records) {
  const keyOf =
    app === "sonarr" ? (r) => (r.episodeId ? `ep:${r.episodeId}` : "") : app === "radarr" ? (r) => (r.movieId ? `movie:${r.movieId}` : "") : null;
  if (!keyOf) return [];
  const list = (records || []).filter((r) => r?.id && r.downloadId);
  const episodesPerDownload = new Map();
  for (const r of list) {
    const set = episodesPerDownload.get(r.downloadId) || new Set();
    set.add(r.episodeId ?? r.movieId);
    episodesPerDownload.set(r.downloadId, set);
  }
  const groups = new Map();
  for (const r of list) {
    const key = keyOf(r);
    if (!key) continue;
    const byDownload = groups.get(key) || new Map();
    if (!byDownload.has(r.downloadId)) byDownload.set(r.downloadId, r);
    groups.set(key, byDownload);
  }
  const out = [];
  const seenLosers = new Set();
  for (const byDownload of groups.values()) {
    if (byDownload.size < 2) continue;
    const ranked = [...byDownload.values()].sort(
      (a, b) =>
        Number(Boolean(a.trouble)) - Number(Boolean(b.trouble)) ||
        (b.resolution || 0) - (a.resolution || 0) ||
        (b.customFormatScore || 0) - (a.customFormatScore || 0) ||
        (a.sizeleft || 0) - (b.sizeleft || 0),
    );
    const winner = ranked[0];
    for (const loser of ranked.slice(1)) {
      if (seenLosers.has(loser.downloadId)) continue;
      if ((episodesPerDownload.get(loser.downloadId)?.size || 0) > 1) continue;
      seenLosers.add(loser.downloadId);
      out.push({ loser, winner });
    }
  }
  return out;
}

/** Skip an item for this long after a failed fix attempt. */
const RETRY_AFTER_MS = 60 * 60 * 1000;
/** @type {Map<string, number>} */
const failedAt = new Map();

const METADATA_MSG = /downloading metadata/i;
const NO_CONNECTIONS_MSG = /stalled with no connections|stalled.*no (peers|seeds)/i;
/** A stuck download that drops out of view this long has its clock reset. */
const STUCK_FORGET_MS = 2 * 60 * 60 * 1000;
const STUCK_FILE = path.join(DATA_DIR, "queue-stuck.json");

/** app:download → { since, seen } (epoch ms). Saved so Hub restarts don't restart the wait. */
function loadStuck() {
  try {
    const data = JSON.parse(fs.readFileSync(STUCK_FILE, "utf8"));
    return new Map(Object.entries(data && typeof data === "object" ? data : {}));
  } catch {
    return new Map();
  }
}

function saveStuck(map) {
  try {
    ensureDataDirs();
    fs.writeFileSync(STUCK_FILE, JSON.stringify(Object.fromEntries(map)));
  } catch {
    /* clock just restarts after a Hub restart */
  }
}

const stuckKey = (app, issue) => `${app}:${issue.downloadId || issue.id}`;

/**
 * Magnet stuck fetching metadata, or torrent stalled with nobody to download from,
 * for longer than the configured wait → blocklist and search for another release.
 * Exported for tests.
 * @returns {{ rule: "stalled", blocklist: true, reason: string } | null}
 */
export function classifyStalled(issue, settings, stuckForMs) {
  if (settings.autoFixStalled === false) return null;
  const msg = String(issue?.errorMessage || "");
  const metadataMs = Math.max(15, Number(settings.stalledMetadataMinutes) || 60) * 60_000;
  const noPeersMs = Math.max(1, Number(settings.stalledNoConnectionsHours) || 6) * 3_600_000;
  if (METADATA_MSG.test(msg) && stuckForMs >= metadataMs) {
    return { rule: "stalled", blocklist: true, reason: `stuck downloading metadata for ${Math.round(stuckForMs / 60_000)} min` };
  }
  if (NO_CONNECTIONS_MSG.test(msg) && stuckForMs >= noPeersMs) {
    return { rule: "stalled", blocklist: true, reason: `stalled with no connections for ${Math.round(stuckForMs / 3_600_000)} h` };
  }
  return null;
}

/**
 * Apply auto-fix rules to the queues from a problems snapshot.
 * @param {Record<string, { ok?: boolean, issues?: object[] }>} queues
 * @param {Record<string, unknown>} settings
 * @param {{ remove?: typeof removeArrQueueItem, now?: number }} [deps]
 * @returns {Promise<{ key: string, app: string, title: string, rule: string, reason: string, blocklist: boolean, keptSeeding: boolean, ok: boolean, error?: string, at: string }[]>}
 */
export async function runQueueAutoFix(queues, settings, deps = {}) {
  if (settings.autoFixEnabled === false) return [];
  const remove = deps.remove || removeArrQueueItem;
  const importer = deps.importer || autoImportDownload;
  const now = deps.now ?? Date.now();
  const max = Math.max(1, Number(settings.autoFixMaxPerScan) || 10);
  const results = [];

  const stuck = deps.stuck || loadStuck();
  for (const [app, q] of Object.entries(queues || {})) {
    if (!q?.ok) continue;
    for (const issue of q.issues || []) {
      const msg = String(issue?.errorMessage || "");
      if (!METADATA_MSG.test(msg) && !NO_CONNECTIONS_MSG.test(msg)) continue;
      const k = stuckKey(app, issue);
      const prev = stuck.get(k);
      stuck.set(k, { since: prev?.since ?? now, seen: now });
    }
  }
  for (const [k, v] of [...stuck]) {
    if (now - (v?.seen || 0) > STUCK_FORGET_MS) stuck.delete(k);
  }
  if (!deps.stuck) saveStuck(stuck);
  const stuckFor = (app, issue) => {
    const v = stuck.get(stuckKey(app, issue));
    return v && v.seen === now ? now - v.since : 0;
  };

  for (const [app, q] of Object.entries(queues || {})) {
    if (!q?.ok) continue;
    const importedDownloads = new Set();
    const importedKeys = new Set();

    if (settings.autoFixDuplicates !== false) {
      for (const { loser, winner } of pickDuplicateLosers(app, q.records)) {
        if (results.length >= max) return results;
        const key = `queue:${app}:${loser.id}`;
        const lastFail = failedAt.get(key);
        if (lastFail != null && now - lastFail < RETRY_AFTER_MS) continue;
        const res = (r) => `${r.resolution ? `${r.resolution}p` : "?p"}${r.trouble ? ", stalled" : ""}`;
        const base = {
          key,
          app,
          title: String(loser.title),
          rule: "duplicate",
          reason: `duplicate (${res(loser)}, CF ${loser.customFormatScore}) — kept ${winner.title} (${res(winner)}, CF ${winner.customFormatScore})`,
          blocklist: false,
          at: new Date(now).toISOString(),
        };
        try {
          const r = await remove({
            app,
            id: loser.id,
            blocklist: false,
            removeFromClient: true,
            indexer: loser.indexer,
            protocol: loser.protocol,
          });
          failedAt.delete(key);
          importedKeys.add(key);
          importedDownloads.add(loser.downloadId);
          results.push({ ...base, keptSeeding: Boolean(r?.keptSeeding), ok: true });
        } catch (err) {
          if (err?.status === 404) continue;
          failedAt.set(key, now);
          results.push({ ...base, keptSeeding: false, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    for (const issue of q.issues || []) {
      if (results.length >= max) return results;
      if (
        settings.autoFixManualImport === false ||
        !AUTO_IMPORT_APPS.has(app) ||
        !issue?.downloadId ||
        importedDownloads.has(issue.downloadId) ||
        classifyQueueIssue(issue, settings) ||
        !needsManualImport(issue)
      ) {
        continue;
      }
      importedDownloads.add(issue.downloadId);
      const group = (q.issues || []).filter((i) => i.downloadId === issue.downloadId);
      const keys = group.map((i) => `queue:${app}:${i.id}`);
      const dlKey = `import:${app}:${issue.downloadId}`;
      const lastTry = failedAt.get(dlKey);
      if (lastTry != null && now - lastTry < RETRY_AFTER_MS) continue;
      const base = {
        key: keys[0],
        keys,
        app,
        title: String(issue.title || "Unknown item"),
        rule: "manualImport",
        reason: "file name matches the grab",
        blocklist: false,
        imported: true,
        keptSeeding: false,
        at: new Date(now).toISOString(),
      };
      try {
        const r = await importer(app, {
          downloadId: issue.downloadId,
          seriesId: issue.seriesId,
          movieId: issue.movieId,
          episodeIds: new Set(
            group.flatMap((i) => [i.episodeId, ...(i.episodeIds || [])]).map(Number).filter(Boolean),
          ),
        });
        if ("imported" in r) {
          failedAt.delete(dlKey);
          for (const k of keys) importedKeys.add(k);
          results.push({ ...base, reason: `${base.reason} (${r.imported} file${r.imported === 1 ? "" : "s"})`, ok: true });
        } else {
          // Not safe to auto-accept (e.g. name mismatch) — leave for a human; re-check hourly.
          failedAt.set(dlKey, now);
        }
      } catch (err) {
        failedAt.set(dlKey, now);
        results.push({ ...base, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }

    for (const issue of q.issues || []) {
      if (importedKeys.has(`queue:${app}:${issue?.id}`)) continue;
      if (issue?.downloadId && importedDownloads.has(issue.downloadId)) continue;
      if (results.length >= max) return results;
      const id = Number(issue?.id);
      if (!Number.isInteger(id) || id <= 0) continue;
      const key = `queue:${app}:${id}`;
      const lastFail = failedAt.get(key);
      if (lastFail != null && now - lastFail < RETRY_AFTER_MS) continue;
      const fix = classifyQueueIssue(issue, settings) || classifyStalled(issue, settings, stuckFor(app, issue));
      if (!fix) continue;
      if (issue.downloadId) importedDownloads.add(issue.downloadId);

      const base = {
        key,
        app,
        title: String(issue.title || "Unknown item"),
        rule: fix.rule,
        reason: fix.reason,
        blocklist: fix.blocklist,
        at: new Date(now).toISOString(),
      };
      try {
        const r = await remove({
          app,
          id,
          blocklist: fix.blocklist,
          removeFromClient: true,
          indexer: issue.indexer,
          protocol: issue.protocol,
        });
        failedAt.delete(key);
        results.push({ ...base, keptSeeding: Boolean(r?.keptSeeding), ok: true });
      } catch (err) {
        // 404: already gone (the *arr cleared it, or it was another row of a download just removed).
        if (err?.status === 404) continue;
        failedAt.set(key, now);
        results.push({
          ...base,
          keptSeeding: false,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return results;
}

const HEALTH_RULES = new Set([
  "nudgeImport",
  "testClients",
  "testIndexer",
  "testApp",
  "cancelHung",
  "sabResume",
  "sabRetry",
  "qbRecheck",
  "qbSlots",
  "qbReannounce",
  "scanUnimported",
  "searchMissing",
  "seasonPack",
  "ombiAvailable",
  "plexRefresh",
]);

export function describeAutoFix(r) {
  if (HEALTH_RULES.has(r.rule)) {
    return `${appLabel(r.app)}: ${r.title} — ${r.ok ? r.reason : `fix failed: ${r.error}`}`;
  }
  if (r.rule === "qbCleanup") {
    return `${appLabel(r.app)}: ${r.title} — ${r.reason} → ${r.ok ? "removed (done seeding)" : `fix failed: ${r.error}`}`;
  }
  const action = r.imported ? "imported" : r.blocklist ? "blocklisted, searching again" : "removed";
  const seed = r.keptSeeding ? " · still seeding in qBittorrent" : "";
  const status = r.ok ? `${action}${seed}` : `fix failed: ${r.error}`;
  return `${appLabel(r.app)}: ${r.title} — ${r.reason} → ${status}`;
}
