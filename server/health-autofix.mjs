import { getArrApiKey } from "./arr-api-keys.mjs";
import { appLabel, arrApiVersion } from "./problems.mjs";
import { parseIndexerList } from "./queue-actions.mjs";
import { createServiceUrlResolver } from "./url-policy.mjs";

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Only metadata refresh / rescan jobs are safe to cancel when hung. */
const CANCELLABLE_COMMANDS = new Set([
  "RefreshSeries",
  "RefreshMovie",
  "RefreshArtist",
  "RefreshAuthor",
  "RescanSeries",
  "RescanMovie",
  "RescanArtist",
  "RescanAuthor",
]);
const QUEUE_APPS = ["sonarr", "radarr", "lidarr", "readarr", "whisparr"];

/** @type {Map<string, number>} */
const lastRun = new Map();

function due(key, intervalMs, now) {
  const last = lastRun.get(key);
  if (last != null && now - last < intervalMs) return false;
  lastRun.set(key, now);
  return true;
}

function defaultApi(resolver) {
  const r = resolver || createServiceUrlResolver({ urls: {} });
  return async (app, method, pathAndQuery, body) => {
    const base = String(r.resolve(app) || "").trim().replace(/\/+$/, "");
    const apiKey = getArrApiKey(app);
    if (!base || !apiKey) throw new Error(`${app} not configured`);
    const res = await fetch(`${base}/api/${arrApiVersion(app)}${pathAndQuery}`, {
      method,
      headers: { "X-Api-Key": apiKey, Accept: "application/json", "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 160)}` : ""}`);
    return text ? JSON.parse(text) : null;
  };
}

function healthItems(snapshot, app, sources) {
  const h = (snapshot.health || []).find((x) => x.id === app);
  return (h?.items || []).filter((i) => sources.includes(i.source));
}

/**
 * Safe, non-destructive health fixes: nudge imports, re-test download clients,
 * indexers and Prowlarr apps, cancel hung metadata refreshes. Never deletes.
 * `quiet` results are routine and are not logged or sent to Discord.
 * @param {{ health?: object[], queues?: Record<string, { ok?: boolean, issues?: object[] }> }} snapshot
 * @param {Record<string, unknown>} settings
 * @param {{ api?: (app: string, method: string, path: string, body?: object) => Promise<any>, now?: number }} [deps]
 */
export async function runHealthAutoFix(snapshot, settings, deps = {}) {
  if (settings.autoFixEnabled === false || settings.autoFixHealth === false) return [];
  const api = deps.api || defaultApi();
  const now = deps.now ?? Date.now();
  const results = [];
  const at = new Date(now).toISOString();
  const push = (app, rule, title, reason, ok, extra = {}) =>
    results.push({ key: `${rule}:${app}:${title}`, app, rule, title, reason, ok, blocklist: false, keptSeeding: false, badge: "Fixed", at, ...extra });

  // Finished downloads waiting on the app's own import pass → run it now.
  for (const app of QUEUE_APPS) {
    const q = snapshot.queues?.[app];
    if (!q?.ok) continue;
    const waiting = (q.issues || []).some(
      (i) => String(i.trackedDownloadState || "").toLowerCase() === "importpending" && !i.errorMessage,
    );
    if (!waiting || !due(`pmd:${app}`, 30 * MIN, now)) continue;
    try {
      await api(app, "POST", "/command", { name: "ProcessMonitoredDownloads" });
      push(app, "nudgeImport", "Check finished downloads", "import pending", true, { quiet: true });
    } catch (err) {
      push(app, "nudgeImport", "Check finished downloads", "import pending", false, { error: String(err?.message || err) });
    }
  }

  for (const app of [...QUEUE_APPS, "prowlarr"]) {
    // Download client marked failed (often a Surfshark blip) → re-test clears the failure counter.
    if (app !== "prowlarr") {
      const dc = healthItems(snapshot, app, ["DownloadClientStatusCheck", "DownloadClientCheck"]).filter(
        (i) => !/remote path|does not appear to exist/i.test(i.message || ""),
      );
      if (dc.length && due(`dct:${app}`, 15 * MIN, now)) {
        try {
          await api(app, "POST", "/downloadclient/testall");
          push(app, "testClients", "Download clients re-tested", "download client unavailable", true, { quiet: true });
        } catch {
          // Still down — Port Watch handles restarts.
        }
      }
    }

    // Indexers disabled after failures → single test (success clears the backoff; failure keeps it).
    const idxHealth = healthItems(snapshot, app, ["IndexerStatusCheck", "IndexerLongTermStatusCheck"]);
    if (idxHealth.length) {
      try {
        const [statuses, indexers] = await Promise.all([
          api(app, "GET", "/indexerstatus"),
          api(app, "GET", "/indexer"),
        ]);
        const privateNames = parseIndexerList(settings.keepSeedingIndexers);
        let tested = 0;
        for (const st of Array.isArray(statuses) ? statuses : []) {
          if (tested >= 3) break;
          const idx = (Array.isArray(indexers) ? indexers : []).find((i) => i.id === st.indexerId);
          if (!idx || idx.enable === false) continue;
          const squashed = String(idx.name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
          const isPrivate = privateNames.some((n) => squashed.includes(n));
          const until = st.disabledTill ? Date.parse(st.disabledTill) : 0;
          if (isPrivate && until > now) continue;
          if (!due(`idx:${app}:${idx.id}`, isPrivate ? 24 * HOUR : 6 * HOUR, now)) continue;
          tested += 1;
          try {
            await api(app, "POST", "/indexer/test", idx);
            push(app, "testIndexer", idx.name, "indexer disabled after failures → test passed, back in rotation", true);
          } catch {
            // Test failed: backoff stays as the app set it.
          }
        }
      } catch {
        // Couldn't read indexer status this scan.
      }
    }
  }

  // Prowlarr can't reach an *arr → re-test that application link.
  const appHealth = healthItems(snapshot, "prowlarr", ["ApplicationStatusCheck", "ApplicationLongTermStatusCheck"]);
  if (appHealth.length) {
    try {
      const apps = await api("prowlarr", "GET", "/applications");
      const text = appHealth.map((i) => i.message || "").join(" ");
      const all = /all applications/i.test(text);
      for (const a of Array.isArray(apps) ? apps : []) {
        if (a.enable === false || (!all && !text.includes(a.name))) continue;
        if (!due(`papp:${a.id}`, 30 * MIN, now)) continue;
        try {
          await api("prowlarr", "POST", "/applications/test", a);
          push("prowlarr", "testApp", a.name, "Prowlarr app link re-tested", true, { quiet: true });
        } catch {
          // Leave it; the *arr is probably down and Port Watch will act.
        }
      }
    } catch {
      // ignore
    }
  }

  // Metadata refresh / rescan hung for hours → cancel (scheduler starts a fresh one later).
  for (const app of QUEUE_APPS) {
    const q = snapshot.queues?.[app];
    if (!q?.ok || !due(`cmdscan:${app}`, HOUR, now)) continue;
    try {
      const cmds = await api(app, "GET", "/command");
      const limit = (app === "lidarr" || app === "readarr" ? 6 : 3) * HOUR;
      const hung = (Array.isArray(cmds) ? cmds : []).find((c) => {
        if (!CANCELLABLE_COMMANDS.has(c.name)) return false;
        if (String(c.status).toLowerCase() === "orphaned") return true;
        const started = Date.parse(c.started || c.startedOn || "");
        return String(c.status).toLowerCase() === "started" && started > 0 && now - started > limit;
      });
      if (hung && due(`cmdcancel:${app}`, 12 * HOUR, now)) {
        await api(app, "DELETE", `/command/${hung.id}`);
        push(app, "cancelHung", `${appLabel(app)} ${hung.name}`, "refresh hung for hours → cancelled", true);
      }
    } catch {
      // ignore
    }
  }

  return results;
}
