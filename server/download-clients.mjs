import { getArrApiKey } from "./arr-api-keys.mjs";
import { loadIntegrationsSettings } from "./integrations.mjs";
import { arrApiVersion, qbLogin } from "./problems.mjs";

export const QUEUE_APPS = ["sonarr", "radarr", "lidarr", "readarr", "whisparr"];
/** Apps whose history proves a download was imported, with the history event that means "imported". */
export const IMPORT_HISTORY = {
  sonarr: { eventType: 3, names: ["downloadFolderImported"] },
  radarr: { eventType: 3, names: ["downloadFolderImported"] },
  lidarr: { eventType: 8, names: ["downloadImported"] },
};

export function normalizeBase(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

export async function getJson(url, headers = {}, timeoutMs = 15_000) {
  const res = await fetch(url, {
    headers: { Accept: "application/json", ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ""}`);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** @returns {{ base: string, apiKey: string, v: string } | null} */
export function arrConn(resolver, app) {
  const base = normalizeBase(resolver.resolve(app));
  const apiKey = getArrApiKey(app);
  return base && apiKey ? { base, apiKey, v: arrApiVersion(app) } : null;
}

export async function arrGet(conn, path, timeoutMs = 30_000) {
  return getJson(`${conn.base}/api/${conn.v}${path}`, { "X-Api-Key": conn.apiKey }, timeoutMs);
}

/** Queue a *arr command (EpisodeSearch, DownloadedEpisodesScan, …). */
export async function arrCommand(conn, body) {
  const res = await fetch(`${conn.base}/api/${conn.v}/command`, {
    method: "POST",
    headers: { "X-Api-Key": conn.apiKey, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${body.name} failed (HTTP ${res.status})${text ? `: ${text.slice(0, 120)}` : ""}`);
  }
}

/** Raw queue records per app. Null when any configured queue can't be read (callers then do nothing destructive). */
export async function fetchArrQueueRecords(resolver) {
  const out = {};
  const ok = await Promise.all(
    QUEUE_APPS.map(async (app) => {
      const conn = arrConn(resolver, app);
      if (!conn) return true;
      try {
        const data = await arrGet(
          conn,
          "/queue?page=1&pageSize=1000&includeUnknownSeriesItems=true&includeUnknownMovieItems=true",
        );
        out[app] = Array.isArray(data?.records) ? data.records : [];
        return true;
      } catch {
        return false;
      }
    }),
  );
  return ok.every(Boolean) ? out : null;
}

export function queueDownloadIds(queues) {
  const ids = new Set();
  for (const records of Object.values(queues || {})) {
    for (const r of records) {
      const id = String(r?.downloadId || "").toLowerCase();
      if (id) ids.add(id);
    }
  }
  return ids;
}

/** All status text on a raw queue record. */
export function queueMessages(record) {
  const parts = [record?.errorMessage];
  for (const sm of record?.statusMessages || []) {
    parts.push(sm?.title, ...(Array.isArray(sm?.messages) ? sm.messages : [sm?.message]));
  }
  return parts.filter(Boolean).join(" · ");
}

/** Download ids each *arr has imported (lower-case) → app id. Kept across passes. */
export const importedBy = new Map();

export async function refreshImportedHashes(resolver) {
  await Promise.all(
    Object.entries(IMPORT_HISTORY).map(async ([app, ev]) => {
      const conn = arrConn(resolver, app);
      if (!conn) return;
      try {
        const qs = new URLSearchParams({ page: "1", pageSize: "2000", sortKey: "date", sortDirection: "descending", eventType: String(ev.eventType) });
        const data = await arrGet(conn, `/history?${qs}`);
        for (const r of Array.isArray(data?.records) ? data.records : []) {
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

/** Logged-in qBittorrent session, or null when qBittorrent isn't configured. */
export async function qbSession(resolver) {
  const base = normalizeBase(resolver.resolve("qbittorrent"));
  const { username, password } = loadIntegrationsSettings().qbittorrent || {};
  if (!base || (!username && !password)) return null;
  const headers = await qbLogin(base, username, password);
  return { base, headers };
}

export async function qbPost(session, path, params) {
  const res = await fetch(`${session.base}/api/v2/${path}`, {
    method: "POST",
    headers: { ...session.headers, "Content-Type": "application/x-www-form-urlencoded", Referer: session.base },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw Object.assign(new Error(`qBittorrent ${path} failed (HTTP ${res.status})`), { status: res.status });
}

/** qBittorrent 5 renamed resume → start. */
export async function qbStart(session, hashes) {
  try {
    await qbPost(session, "torrents/start", { hashes });
  } catch (err) {
    if (err?.status !== 404) throw err;
    await qbPost(session, "torrents/resume", { hashes });
  }
}

/** SABnzbd API url builder, or null when SABnzbd isn't configured. */
export function sabApi(resolver) {
  const base = normalizeBase(resolver.resolve("sabnzbd")).replace(/\/sabnzbd\/?$/i, "");
  const apiKey = loadIntegrationsSettings().sabnzbd?.apiKey || "";
  if (!base || !apiKey) return null;
  return (params) => `${base}/sabnzbd/api?${new URLSearchParams({ output: "json", apikey: apiKey, ...params })}`;
}
