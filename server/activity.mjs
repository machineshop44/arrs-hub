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

async function getArrQueue(id, baseUrl, apiKey) {
  const base = normalizeBase(baseUrl);
  if (!base || !apiKey) {
    return { ok: false, configured: false, total: 0, downloading: 0 };
  }
  const version = arrApiVersion(id);
  // pageSize=1 is enough — dashboard Activity only shows queue counts, not titles.
  const url = `${base}/api/${version}/queue?page=1&pageSize=1&includeUnknownSeriesItems=true&includeUnknownMovieItems=true`;
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
    return {
      ok: true,
      configured: true,
      total,
      downloading: total,
    };
  } catch (err) {
    return {
      ok: false,
      configured: true,
      total: 0,
      downloading: 0,
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

function countOmbiPending(list) {
  return Array.isArray(list) ? list.filter(isOmbiAwaitingApproval).length : 0;
}

/**
 * Count Ombi requests pending approval (movie + TV + music).
 * Prefers explicit list filtering over /Request/count — that endpoint can omit
 * music and (on some Ombi versions) lump denied into pending.
 */
async function getOmbiPending(baseUrl, apiKey) {
  const base = normalizeBase(baseUrl);
  if (!base || !apiKey) {
    return { ok: false, configured: false, pending: 0 };
  }
  try {
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

    const pending =
      countOmbiPending(movies) +
      countOmbiPending(tv) +
      countOmbiPending(musicList);

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
