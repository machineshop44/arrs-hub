import { loadSyncSettings } from "./config.mjs";
import { loadIntegrationsSettings } from "./integrations.mjs";
import { getTautulliActivity, loadTautulliSettings } from "./tautulli.mjs";

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
      .slice(0, 12);
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
 * Pending Ombi requests with enough detail for the dashboard chip popover.
 * @param {{ urls?: Record<string, string> }} [opts]
 */
export async function getOmbiPendingRequests(opts = {}) {
  const urls = opts.urls || {};
  const integrations = loadIntegrationsSettings();
  const ombiUrl = normalizeBase(urls.ombi || integrations.ombi.baseUrl);
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

  const urls = body.urls || {};
  const integrations = loadIntegrationsSettings();
  const ombiUrl = normalizeBase(urls.ombi || integrations.ombi.baseUrl);
  const apiKey = integrations.ombi.apiKey;
  if (!ombiUrl || !apiKey) {
    throw Object.assign(new Error("Ombi is not configured (URL + API key)"), {
      status: 400,
    });
  }

  const pathByType = {
    movie: "movie/approve",
    tv: "tv/approve",
    music: "music/approve",
  };
  const url = `${ombiUrl}/api/v1/Request/${pathByType[type]}`;
  const data = await fetchJson(url, {
    method: "POST",
    headers: {
      ApiKey: apiKey,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id }),
  });

  // Ombi often returns { result, isError, errorMessage, message }.
  if (data && typeof data === "object") {
    if (data.isError === true || data.result === false) {
      const msg =
        data.errorMessage || data.message || "Ombi approve failed";
      throw Object.assign(new Error(String(msg)), { status: 502 });
    }
  }

  return { ok: true, type, id, ombi: data ?? null };
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

/**
 * Aggregate high-level hub status for the dashboard chips + activity strip.
 * @param {{ urls?: Record<string, string> }} [opts]
 */
export async function getHubStatusSummary(opts = {}) {
  const urls = opts.urls || {};
  const sync = loadSyncSettings();
  const integrations = loadIntegrationsSettings();

  const sonarrUrl = normalizeBase(urls.sonarr || sync.sonarr.baseUrl);
  const radarrUrl = normalizeBase(urls.radarr || sync.radarr.baseUrl);
  const lidarrUrl = normalizeBase(urls.lidarr || "");
  const qbUrl = normalizeBase(
    urls.qbittorrent || integrations.qbittorrent.baseUrl,
  );
  const sabUrl = normalizeBase(urls.sabnzbd || integrations.sabnzbd.baseUrl);
  const ombiUrl = normalizeBase(urls.ombi || integrations.ombi.baseUrl);

  const [sonarr, radarr, lidarr, qb, sab, ombi, streams] = await Promise.all([
    getArrQueue("sonarr", sonarrUrl, sync.sonarr.apiKey),
    getArrQueue("radarr", radarrUrl, sync.radarr.apiKey),
    lidarrUrl
      ? getArrQueue("lidarr", lidarrUrl, "")
      : Promise.resolve({
          ok: false,
          configured: false,
          total: 0,
          downloading: 0,
          issues: [],
        }),
    getQbittorrentActive(
      qbUrl,
      integrations.qbittorrent.username,
      integrations.qbittorrent.password,
    ),
    getSabnzbdActive(sabUrl, integrations.sabnzbd.apiKey),
    getOmbiPending(ombiUrl, integrations.ombi.apiKey),
    getStreamsSummary(),
  ]);

  const arrQueueTotal =
    (sonarr.ok ? sonarr.total : 0) +
    (radarr.ok ? radarr.total : 0) +
    (lidarr.ok ? lidarr.total : 0);

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
      sonarr,
      radarr,
      lidarr,
    },
  };
}
