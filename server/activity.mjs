import { loadSyncSettings } from "./config.mjs";
import { loadIntegrationsSettings } from "./integrations.mjs";
import { getArrApiKey } from "./arr-api-keys.mjs";
import { getTautulliActivity, loadTautulliSettings } from "./tautulli.mjs";
import { createServiceUrlResolver } from "./url-policy.mjs";
import {
  assertOmbiOk,
  normalizeOmbiBase,
  ombiApprovePath,
  ombiDenyPath,
  ombiHttp,
  requestOmbiMedia,
  searchOmbi,
} from "./ombi-client.mjs";

function normalizeBase(url) {
  return String(url || "")
    .trim()
    .replace(/\/+$/, "");
}

function arrApiVersion(id) {
  if (id === "lidarr" || id === "readarr" || id === "prowlarr") return "v1";
  return "v3";
}

async function fetchJson(url, options = {}, timeoutMs = 8000) {
  const res = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const detail =
      (data && (data.message || data.error || data.detail)) ||
      text.slice(0, 160) ||
      res.statusText;
    throw new Error(
      typeof detail === "string" ? detail : `HTTP ${res.status}`,
    );
  }
  return data;
}

/** Queue rows that need attention (manual import / warning / failed). */
function isQueueIssue(record) {
  if (!record || typeof record !== "object") return false;
  const trackedStatus = String(record.trackedDownloadStatus || "").toLowerCase();
  const trackedState = String(record.trackedDownloadState || "").toLowerCase();
  const status = String(record.status || "").toLowerCase();
  if (trackedStatus === "warning" || trackedStatus === "error") return true;
  if (
    trackedState === "importpending" ||
    trackedState === "failedpending" ||
    trackedState === "failed"
  ) {
    return true;
  }
  if (status === "warning" || status === "failed") return true;
  if (record.errorMessage) return true;
  return false;
}

function summarizeQueueIssue(record) {
  const messages = [];
  if (record.errorMessage) messages.push(String(record.errorMessage));
  if (Array.isArray(record.statusMessages)) {
    for (const sm of record.statusMessages) {
      if (Array.isArray(sm?.messages)) {
        for (const m of sm.messages) {
          if (m) messages.push(String(m));
        }
      } else if (sm?.message) {
        messages.push(String(sm.message));
      }
    }
  }
  return {
    id: record.id ?? null,
    title: record.title || record.sourceTitle || "Unknown item",
    status: record.status || "",
    trackedDownloadStatus: record.trackedDownloadStatus || "",
    trackedDownloadState: record.trackedDownloadState || "",
    errorMessage: messages.filter(Boolean).slice(0, 3).join(" · "),
    outputPath: record.outputPath || "",
    indexer: record.indexer || "",
    protocol: record.protocol || "",
    downloadClient: record.downloadClient || "",
    downloadId: record.downloadId || "",
    seriesId: record.seriesId ?? null,
    episodeId: record.episodeId ?? null,
    episodeIds: Array.isArray(record.episodeIds) ? record.episodeIds : [],
    movieId: record.movieId ?? null,
  };
}

async function getArrQueue(id, baseUrl, apiKey) {
  const base = normalizeBase(baseUrl);
  if (!base || !apiKey) {
    return {
      ok: false,
      configured: false,
      total: 0,
      downloading: 0,
      issues: [],
    };
  }
  const version = arrApiVersion(id);
  // Fetch a page of records so the chip popover can list stuck / manual-import items.
  // totalRecords still drives the chip count.
  const url = `${base}/api/${version}/queue?page=1&pageSize=50&includeUnknownSeriesItems=true&includeUnknownMovieItems=true`;
  try {
    const data = await fetchJson(url, {
      headers: { "X-Api-Key": apiKey, Accept: "application/json" },
    });
    const records = Array.isArray(data?.records)
      ? data.records
      : Array.isArray(data)
        ? data
        : [];
    const total = Number(data?.totalRecords ?? records.length) || records.length;
    const issues = records
      .filter(isQueueIssue)
      .map(summarizeQueueIssue)
      .slice(0, 25);
    return {
      ok: true,
      configured: true,
      total,
      downloading: total,
      issues,
    };
  } catch (err) {
    return {
      ok: false,
      configured: true,
      total: 0,
      downloading: 0,
      issues: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function getQbittorrentActive(baseUrl, username, password) {
  const base = normalizeBase(baseUrl);
  if (!base) {
    return { ok: false, configured: false, active: 0 };
  }
  if (!username && !password) {
    return { ok: false, configured: false, active: 0 };
  }
  try {
    const loginRes = await fetch(`${base}/api/v2/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `username=${encodeURIComponent(username || "")}&password=${encodeURIComponent(password || "")}`,
      signal: AbortSignal.timeout(8000),
    });
    const cookie = loginRes.headers.get("set-cookie") || "";
    if (!loginRes.ok) {
      throw new Error(`Login failed (${loginRes.status})`);
    }
    const text = await loginRes.text();
    if (text.trim().toLowerCase() === "fails.") {
      throw new Error("Invalid qBittorrent username/password");
    }
    const torrents = await fetchJson(
      `${base}/api/v2/torrents/info?filter=downloading`,
      {
        headers: cookie ? { Cookie: cookie.split(";")[0] } : {},
      },
    );
    const list = Array.isArray(torrents) ? torrents : [];
    return { ok: true, configured: true, active: list.length };
  } catch (err) {
    return {
      ok: false,
      configured: true,
      active: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function getSabnzbdActive(baseUrl, apiKey) {
  const base = normalizeBase(baseUrl);
  if (!base || !apiKey) {
    return { ok: false, configured: false, active: 0 };
  }
  try {
    const root = base.replace(/\/sabnzbd\/?$/i, "");
    const url = `${root}/sabnzbd/api?mode=queue&output=json&apikey=${encodeURIComponent(apiKey)}`;
    const data = await fetchJson(url);
    const slots = Array.isArray(data?.queue?.slots) ? data.queue.slots : [];
    const noOfSlots = Number(data?.queue?.noofslots ?? slots.length) || slots.length;
    return { ok: true, configured: true, active: noOfSlots };
  } catch (err) {
    return {
      ok: false,
      configured: true,
      active: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Ombi request awaiting admin approval (not denied / not already available). */
function isOmbiAwaitingApproval(row) {
  if (!row || typeof row !== "object") return false;
  if (row.available === true) return false;
  if (row.denied === true) return false;
  if (row.deniedDate) return false;
  return row.approved === false;
}

function ombiRequester(row) {
  if (!row || typeof row !== "object") return "";
  const user = row.requestedUser;
  if (user && typeof user === "object") {
    return (
      String(user.userAlias || user.userName || user.userLogin || "").trim() ||
      ""
    );
  }
  return String(row.requestedByAlias || "").trim();
}

function summarizeOmbiMovie(row) {
  return {
    id: Number(row.id),
    type: "movie",
    title: String(row.title || "Untitled movie"),
    requester: ombiRequester(row),
  };
}

function summarizeOmbiMusic(row) {
  return {
    id: Number(row.id),
    type: "music",
    title: String(row.title || row.albumName || "Untitled album"),
    requester: ombiRequester(row),
  };
}

/**
 * TV parents do not carry approved/denied — those live on childRequests.
 * Approve API also expects the child request id.
 */
function summarizeOmbiTvPending(parent) {
  const children = Array.isArray(parent?.childRequests)
    ? parent.childRequests
    : [];
  const title = String(parent?.title || "Untitled series");
  const out = [];
  for (const child of children) {
    if (!isOmbiAwaitingApproval(child)) continue;
    const id = Number(child.id);
    if (!Number.isFinite(id)) continue;
    out.push({
      id,
      type: "tv",
      title,
      requester: ombiRequester(child) || ombiRequester(parent),
    });
  }
  // Older/odd payloads may flatten approved onto the parent.
  if (out.length === 0 && isOmbiAwaitingApproval(parent)) {
    const id = Number(parent.id);
    if (Number.isFinite(id)) {
      out.push({
        id,
        type: "tv",
        title,
        requester: ombiRequester(parent),
      });
    }
  }
  return out;
}

async function fetchOmbiRequestLists(baseUrl, apiKey) {
  const base = normalizeBase(baseUrl);
  if (!base || !apiKey) {
    return { configured: false, movies: [], tv: [], music: [] };
  }
  const headers = {
    ApiKey: apiKey,
    Accept: "application/json",
  };
  const [movies, tv, music] = await Promise.all([
    fetchJson(`${base}/api/v1/Request/movie`, { headers }).catch(() => []),
    fetchJson(`${base}/api/v1/Request/tv`, { headers }).catch(() => []),
    fetchJson(`${base}/api/v1/Request/music`, { headers }).catch(() => null),
  ]);

  let musicList = music;
  if (!Array.isArray(musicList)) {
    musicList = await fetchJson(`${base}/api/v1/Request/album`, {
      headers,
    }).catch(() => []);
  }

  return {
    configured: true,
    base,
    movies: Array.isArray(movies) ? movies : [],
    tv: Array.isArray(tv) ? tv : [],
    music: Array.isArray(musicList) ? musicList : [],
  };
}

function collectOmbiPendingItems(lists) {
  const items = [];
  for (const row of lists.movies) {
    if (!isOmbiAwaitingApproval(row)) continue;
    const id = Number(row.id);
    if (!Number.isFinite(id)) continue;
    items.push(summarizeOmbiMovie(row));
  }
  for (const parent of lists.tv) {
    items.push(...summarizeOmbiTvPending(parent));
  }
  for (const row of lists.music) {
    if (!isOmbiAwaitingApproval(row)) continue;
    const id = Number(row.id);
    if (!Number.isFinite(id)) continue;
    items.push(summarizeOmbiMusic(row));
  }
  items.sort((a, b) => {
    const typeCmp = String(a.type).localeCompare(String(b.type));
    if (typeCmp !== 0) return typeCmp;
    return String(a.title).localeCompare(String(b.title));
  });
  return items;
}

/**
 * Count Ombi requests pending approval (movie + TV + music).
 * Prefers explicit list filtering over /Request/count — that endpoint can omit
 * music and (on some Ombi versions) lump denied into pending.
 */
async function getOmbiPending(baseUrl, apiKey) {
  if (!normalizeBase(baseUrl) || !apiKey) {
    return { ok: false, configured: false, pending: 0 };
  }
  try {
    const lists = await fetchOmbiRequestLists(baseUrl, apiKey);
    const pending = collectOmbiPendingItems(lists).length;
    return { ok: true, configured: true, pending };
  } catch (err) {
    return {
      ok: false,
      configured: true,
      pending: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * @param {{ urls?: Record<string, string>, resolver?: ReturnType<typeof createServiceUrlResolver> }} opts
 */
function resolverFrom(opts = {}) {
  return opts.resolver || createServiceUrlResolver({ urls: opts.urls || {} });
}

/**
 * Pending Ombi requests with enough detail for the dashboard chip popover.
 * @param {{ urls?: Record<string, string>, resolver?: ReturnType<typeof createServiceUrlResolver> }} [opts]
 */
export async function getOmbiPendingRequests(opts = {}) {
  const integrations = loadIntegrationsSettings();
  const ombiUrl = normalizeBase(resolverFrom(opts).resolve("ombi"));
  const apiKey = integrations.ombi.apiKey;

  if (!ombiUrl || !apiKey) {
    return {
      ok: false,
      configured: false,
      pending: 0,
      items: [],
      ombiUrl: ombiUrl || null,
    };
  }

  try {
    const lists = await fetchOmbiRequestLists(ombiUrl, apiKey);
    const items = collectOmbiPendingItems(lists);
    return {
      ok: true,
      configured: true,
      pending: items.length,
      items,
      ombiUrl,
    };
  } catch (err) {
    return {
      ok: false,
      configured: true,
      pending: 0,
      items: [],
      ombiUrl,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function resolveOmbiConnection(body = {}) {
  const integrations = loadIntegrationsSettings();
  const ombiUrl = normalizeOmbiBase(resolverFrom(body).resolve("ombi"));
  const apiKey = String(integrations.ombi.apiKey || "").trim();
  if (!ombiUrl || !apiKey) {
    throw Object.assign(new Error("Ombi is not configured (URL + API key)"), {
      status: 400,
    });
  }
  return { ombiUrl, apiKey };
}

/**
 * Approve a pending Ombi request via Ombi's Request API.
 * Movie/music: request id. TV: child request id (see summarizeOmbiTvPending).
 * @param {{ type: string, id: number, urls?: Record<string, string> }} body
 */
export async function approveOmbiRequest(body = {}) {
  const type = String(body.type || "").toLowerCase();
  const id = Number(body.id);
  if (!["movie", "tv", "music"].includes(type)) {
    throw Object.assign(new Error("type must be movie, tv, or music"), {
      status: 400,
    });
  }
  if (!Number.isFinite(id) || id <= 0) {
    throw Object.assign(new Error("id must be a positive number"), {
      status: 400,
    });
  }

  const approvePath = ombiApprovePath(type);
  const { ombiUrl, apiKey } = resolveOmbiConnection(body);
  const { status, data } = await ombiHttp(
    ombiUrl,
    apiKey,
    `/api/v1/Request/${approvePath}`,
    { method: "POST", body: { id } },
  );
  assertOmbiOk(status, data, "Ombi approve failed");
  return { ok: true, type, id, ombi: data ?? null };
}

/**
 * Deny a pending Ombi request via Ombi's Request API (PUT).
 * @param {{ type: string, id: number, reason?: string, urls?: Record<string, string> }} body
 */
export async function denyOmbiRequest(body = {}) {
  const type = String(body.type || "").toLowerCase();
  const id = Number(body.id);
  if (!["movie", "tv", "music"].includes(type)) {
    throw Object.assign(new Error("type must be movie, tv, or music"), {
      status: 400,
    });
  }
  if (!Number.isFinite(id) || id <= 0) {
    throw Object.assign(new Error("id must be a positive number"), {
      status: 400,
    });
  }

  const denyPath = ombiDenyPath(type);
  const { ombiUrl, apiKey } = resolveOmbiConnection(body);
  const payload = { id };
  const reason = String(body.reason || "").trim();
  if (reason) payload.reason = reason;

  // Ombi deny endpoints are PUT (not POST).
  const { status, data } = await ombiHttp(
    ombiUrl,
    apiKey,
    `/api/v1/Request/${denyPath}`,
    { method: "PUT", body: payload },
  );
  assertOmbiOk(status, data, "Ombi deny failed");
  return { ok: true, type, id, ombi: data ?? null };
}

/**
 * Search Ombi (movies+TV or music). Server-side so the API key stays on Hub.
 * @param {{ mode?: string, query: string, urls?: Record<string, string> }} body
 */
export async function searchOmbiRequests(body = {}) {
  const { ombiUrl, apiKey } = resolveOmbiConnection(body);
  const mode =
    String(body.mode || "media").toLowerCase() === "music"
      ? "music"
      : "media";
  const results = await searchOmbi(ombiUrl, apiKey, mode, body.query);
  return {
    ok: true,
    configured: true,
    mode,
    query: String(body.query || "").trim(),
    results,
    ombiUrl,
  };
}

/**
 * Submit a media request through Ombi.
 * @param {{ kind: string, title?: string, tmdbId?: number, tvdbId?: number, foreignAlbumId?: string, available?: boolean, requested?: boolean, approved?: boolean, urls?: Record<string, string> }} body
 */
export async function submitOmbiRequest(body = {}) {
  const { ombiUrl, apiKey } = resolveOmbiConnection(body);
  const hit = {
    kind: String(body.kind || "").toLowerCase(),
    title: String(body.title || "").trim() || "Untitled",
    tmdbId: body.tmdbId ?? null,
    tvdbId: body.tvdbId ?? null,
    foreignAlbumId: body.foreignAlbumId ?? null,
    available: body.available === true,
    requested: body.requested === true,
    approved: body.approved === true,
  };
  const result = await requestOmbiMedia(ombiUrl, apiKey, hit);
  return { ...result, kind: hit.kind, ombiUrl };
}

async function getStreamsSummary() {
  try {
    const settings = loadTautulliSettings();
    if (!settings.apiKey?.trim()) {
      return { ok: false, configured: false, streamCount: 0 };
    }
    const activity = await getTautulliActivity();
    return {
      ok: true,
      configured: true,
      streamCount: activity.streamCount,
    };
  } catch (err) {
    const code = err?.code;
    return {
      ok: false,
      configured: code !== "TAUTULLI_NOT_CONFIGURED",
      streamCount: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** *arr apps whose download queue feeds the summary (additive: readarr/whisparr). */
export const SUMMARY_QUEUE_APP_IDS = [
  "sonarr",
  "radarr",
  "lidarr",
  "readarr",
  "whisparr",
];

/**
 * Queue snapshot for each *arr in SUMMARY_QUEUE_APP_IDS.
 * @param {ReturnType<typeof createServiceUrlResolver>} resolver
 */
export async function getArrQueues(resolver) {
  const sync = loadSyncSettings();
  const entries = await Promise.all(
    SUMMARY_QUEUE_APP_IDS.map(async (id) => {
      const url = normalizeBase(resolver.resolve(id));
      const apiKey =
        id === "sonarr" || id === "radarr"
          ? sync[id]?.apiKey || ""
          : getArrApiKey(id);
      return [id, await getArrQueue(id, url, apiKey)];
    }),
  );
  return Object.fromEntries(entries);
}

/**
 * Aggregate high-level hub status for the dashboard chips + activity strip.
 * @param {{ urls?: Record<string, string>, resolver?: ReturnType<typeof createServiceUrlResolver> }} [opts]
 */
export async function getHubStatusSummary(opts = {}) {
  const resolver = resolverFrom(opts);
  const integrations = loadIntegrationsSettings();

  const qbUrl = normalizeBase(resolver.resolve("qbittorrent"));
  const sabUrl = normalizeBase(resolver.resolve("sabnzbd"));
  const ombiUrl = normalizeBase(resolver.resolve("ombi"));

  const [queues, qb, sab, ombi, streams] = await Promise.all([
    getArrQueues(resolver),
    getQbittorrentActive(
      qbUrl,
      integrations.qbittorrent.username,
      integrations.qbittorrent.password,
    ),
    getSabnzbdActive(sabUrl, integrations.sabnzbd.apiKey),
    getOmbiPending(ombiUrl, integrations.ombi.apiKey),
    getStreamsSummary(),
  ]);

  const arrQueueTotal = SUMMARY_QUEUE_APP_IDS.reduce(
    (sum, id) => sum + (queues[id]?.ok ? queues[id].total : 0),
    0,
  );

  const downloadsActive =
    (qb.ok ? qb.active : 0) + (sab.ok ? sab.active : 0);

  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    streams,
    downloads: {
      active: downloadsActive,
      qbittorrent: qb,
      sabnzbd: sab,
    },
    ombi,
    arr: {
      queueTotal: arrQueueTotal,
      ...queues,
    },
  };
}
