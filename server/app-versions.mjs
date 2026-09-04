import { comparePlexVersions } from "./plex-update.mjs";
import { ARR_API_APP_IDS, getArrApiKey } from "./arr-api-keys.mjs";
import { loadWatchdogSettings } from "./watchdog-store.mjs";
import {
  checkCompanionHealth,
  requestCompanionLocalAppVersions,
} from "./companion-client.mjs";
import { loadIntegrationsSettings } from "./integrations.mjs";
import {
  loadTautulliSettings,
  normalizeTautulliBaseUrl,
} from "./tautulli.mjs";
import { getHubLocalFileFlowsVersions } from "./hub-local-versions.mjs";

function normalizeBase(url) {
  return String(url || "")
    .trim()
    .replace(/\/+$/, "");
}

async function fetchJson(url, options = {}, timeoutMs = 4000) {
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
      text.slice(0, 120) ||
      res.statusText;
    throw new Error(typeof detail === "string" ? detail : `HTTP ${res.status}`);
  }
  return data;
}

function arrApiVersion(id) {
  if (id === "bazarr") return null; // Bazarr uses /api/system/... (no v#)
  if (id === "lidarr" || id === "readarr" || id === "prowlarr") return "v1";
  return "v3";
}

function arrStatusPath(id) {
  const ver = arrApiVersion(id);
  if (!ver) return "/api/system/status";
  return `/api/${ver}/system/status`;
}

function arrUpdatePath(id) {
  const ver = arrApiVersion(id);
  if (!ver) return null; // Bazarr has no *arr-style /update list
  return `/api/${ver}/update`;
}

function extractArrVersion(id, status) {
  if (id === "bazarr") {
    return shortAppVersion(
      status?.bazarr_version ||
        status?.data?.bazarr_version ||
        status?.version ||
        status?.data?.version ||
        "",
    );
  }
  return shortAppVersion(status?.version || status?.data?.version || "");
}

export function shortAppVersion(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  const match = text.match(/(\d+\.\d+(?:\.\d+)?(?:\.\d+)?)/);
  return match ? match[1] : text.slice(0, 16);
}

const SERVICE_LABELS = {
  sonarr: "Sonarr",
  radarr: "Radarr",
  lidarr: "Lidarr",
  readarr: "Readarr",
  prowlarr: "Prowlarr",
  bazarr: "Bazarr",
  whisparr: "Whisparr",
  qbittorrent: "qBittorrent",
  sabnzbd: "SABnzbd",
  fileflows: "FileFlows",
  "fileflows-node": "FileFlows Node",
  tautulli: "Tautulli",
  surfshark: "Surfshark",
};

const ARR_IDS = ARR_API_APP_IDS;
const COMPANION_APP_ORDER = [
  "qbittorrent",
  "sabnzbd",
  "fileflows-node",
  "fileflows",
  "surfshark",
];

/** @type {Map<string, { at: number, version: string|null }>} */
const githubLatestCache = new Map();
const GITHUB_CACHE_MS = 60 * 60 * 1000;

/**
 * @param {string} repo e.g. qbittorrent/qBittorrent
 */
async function githubLatestVersion(repo) {
  const cached = githubLatestCache.get(repo);
  if (cached && Date.now() - cached.at < GITHUB_CACHE_MS) {
    return cached.version;
  }
  try {
    const data = await fetchJson(
      `https://api.github.com/repos/${repo}/releases/latest`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "Arrs-Hub",
        },
      },
      8000,
    );
    const version = shortAppVersion(data?.tag_name || data?.name || "");
    githubLatestCache.set(repo, { at: Date.now(), version: version || null });
    return version || null;
  } catch {
    githubLatestCache.set(repo, { at: Date.now(), version: null });
    return null;
  }
}

function emptyAppInfo(id, openUrl = null) {
  return {
    id,
    label: SERVICE_LABELS[id] || id,
    configured: false,
    ok: false,
    version: null,
    updateAvailable: false,
    latestVersion: null,
    openUrl,
  };
}

function withGithubUpdate(row, latest) {
  const installed = row.version;
  const updateAvailable = Boolean(
    installed && latest && comparePlexVersions(latest, installed) > 0,
  );
  return {
    ...row,
    updateAvailable,
    latestVersion: updateAvailable ? latest : null,
  };
}

/**
 * @param {string} id
 * @param {string} baseUrl
 * @param {string} apiKey
 */
async function fetchArrUpdateInfo(id, baseUrl, apiKey) {
  const label = SERVICE_LABELS[id] || id;
  const base = normalizeBase(baseUrl);
  if (!base && !apiKey) {
    return emptyAppInfo(id, null);
  }
  if (!base) {
    return {
      ...emptyAppInfo(id, null),
      configured: Boolean(apiKey),
      error: "No Home/Remote URL set for this app in Settings.",
    };
  }
  if (!apiKey) {
    return {
      ...emptyAppInfo(id, `${base}/`),
      configured: false,
      error: "API key not saved — add it under Settings → Apps & monitoring.",
    };
  }

  const headers = { "X-Api-Key": apiKey, Accept: "application/json" };
  // Bazarr also accepts apikey query on some builds.
  const statusUrl =
    id === "bazarr"
      ? `${base}${arrStatusPath(id)}?apikey=${encodeURIComponent(apiKey)}`
      : `${base}${arrStatusPath(id)}`;

  try {
    const status = await fetchJson(statusUrl, { headers });
    const installed = extractArrVersion(id, status);
    let updateAvailable = false;
    let latestVersion = null;

    const updatePath = arrUpdatePath(id);
    if (updatePath) {
      try {
        const updates = await fetchJson(`${base}${updatePath}`, { headers });
        const list = Array.isArray(updates) ? updates : [];
        for (const entry of list) {
          const candidate = shortAppVersion(entry?.version);
          if (!candidate || !installed) continue;
          if (comparePlexVersions(candidate, installed) > 0) {
            if (
              !latestVersion ||
              comparePlexVersions(candidate, latestVersion) > 0
            ) {
              latestVersion = candidate;
              updateAvailable = true;
            }
          }
        }
      } catch {
        // Some installs block /update — still return installed version.
      }
    } else if (id === "bazarr" && installed) {
      try {
        const latest = await githubLatestVersion("morpheus65535/bazarr");
        if (latest && comparePlexVersions(latest, installed) > 0) {
          updateAvailable = true;
          latestVersion = latest;
        }
      } catch {
        // ignore
      }
    }

    return {
      id,
      label,
      configured: true,
      ok: true,
      version: installed || null,
      updateAvailable,
      latestVersion,
      openUrl: `${base}/`,
    };
  } catch (err) {
    return {
      id,
      label,
      configured: true,
      ok: false,
      version: null,
      updateAvailable: false,
      latestVersion: null,
      openUrl: `${base}/`,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function fetchQbitVersion(baseUrl, username, password) {
  const base = normalizeBase(baseUrl);
  const openUrl = base ? `${base}/` : null;
  if (!base) return emptyAppInfo("qbittorrent", openUrl);

  try {
    const headers = {};
    if (username || password) {
      const loginRes = await fetch(`${base}/api/v2/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `username=${encodeURIComponent(username || "")}&password=${encodeURIComponent(password || "")}`,
        signal: AbortSignal.timeout(8000),
      });
      const cookie = loginRes.headers.get("set-cookie") || "";
      const text = await loginRes.text();
      if (!loginRes.ok || text.trim().toLowerCase() === "fails.") {
        throw new Error("qBittorrent login failed");
      }
      if (cookie) headers.Cookie = cookie.split(";")[0];
    }

    const verRes = await fetch(`${base}/api/v2/app/version`, {
      headers,
      signal: AbortSignal.timeout(6000),
    });
    const raw = (await verRes.text()).trim();
    if (!verRes.ok) throw new Error(`qBittorrent version HTTP ${verRes.status}`);
    const installed = shortAppVersion(raw);
    const latest = await githubLatestVersion("qbittorrent/qBittorrent");
    return withGithubUpdate(
      {
        id: "qbittorrent",
        label: SERVICE_LABELS.qbittorrent,
        configured: true,
        ok: true,
        version: installed || null,
        openUrl,
      },
      latest,
    );
  } catch (err) {
    return {
      ...emptyAppInfo("qbittorrent", openUrl),
      configured: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function fetchSabVersion(baseUrl, apiKey) {
  const base = normalizeBase(baseUrl);
  const openUrl = base ? `${base}/` : null;
  if (!base) return emptyAppInfo("sabnzbd", openUrl);

  try {
    const root = base.replace(/\/sabnzbd\/?$/i, "");
    const url = `${root}/sabnzbd/api?mode=version&output=json${
      apiKey ? `&apikey=${encodeURIComponent(apiKey)}` : ""
    }`;
    const data = await fetchJson(url, {}, 6000);
    const installed = shortAppVersion(
      typeof data === "string" ? data : data?.version || "",
    );
    const latest = await githubLatestVersion("sabnzbd/sabnzbd");
    return withGithubUpdate(
      {
        id: "sabnzbd",
        label: SERVICE_LABELS.sabnzbd,
        configured: Boolean(apiKey) || Boolean(installed),
        ok: Boolean(installed),
        version: installed || null,
        openUrl,
      },
      latest,
    );
  } catch (err) {
    return {
      ...emptyAppInfo("sabnzbd", openUrl),
      configured: Boolean(apiKey),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function fetchTautulliUpdateInfo(baseUrl, apiKey) {
  const base = normalizeTautulliBaseUrl(baseUrl || "");
  const openUrl = base ? `${base}/` : null;
  const key = String(apiKey || "").trim();
  if (!base || !key) {
    return emptyAppInfo("tautulli", openUrl);
  }

  const api = (cmd) =>
    fetchJson(
      `${base}/api/v2?apikey=${encodeURIComponent(key)}&cmd=${encodeURIComponent(cmd)}`,
      {},
      8000,
    );

  try {
    const info = await api("get_tautulli_info");
    const payload = info?.response?.data || info?.data || info?.response || {};
    const installed = shortAppVersion(
      payload?.tautulli_version || payload?.version || "",
    );

    let updateAvailable = false;
    let latestVersion = null;

    try {
      const check = await api("update_check");
      const resp = check?.response || check || {};
      const result = String(resp?.result || "").toLowerCase();

      // update_check puts flags on response (not always under data) — match Tautulli UI.
      const updateFlag =
        resp?.update === true ||
        resp?.update === 1 ||
        resp?.update === "true" ||
        (resp?.data &&
          typeof resp.data === "object" &&
          (resp.data.update === true ||
            resp.data.update === 1 ||
            resp.data.update === "true"));

      const latestRaw =
        resp?.latest_release ||
        resp?.latest_version ||
        resp?.data?.latest_release ||
        resp?.data?.latest_version ||
        "";
      latestVersion = shortAppVersion(String(latestRaw).replace(/^v/i, "")) || null;

      if (result === "error") {
        // Unknown install — don't guess from GitHub.
        updateAvailable = false;
        latestVersion = null;
      } else if (updateFlag) {
        updateAvailable = true;
      } else {
        // Tautulli says up to date — trust it (branch/channel aware).
        updateAvailable = false;
        latestVersion = null;
      }
    } catch {
      // update_check failed — show installed version only, no yellow row.
      updateAvailable = false;
      latestVersion = null;
    }

    return {
      id: "tautulli",
      label: SERVICE_LABELS.tautulli,
      configured: true,
      ok: Boolean(installed),
      version: installed || null,
      updateAvailable,
      latestVersion: updateAvailable ? latestVersion : null,
      openUrl,
    };
  } catch (err) {
    return {
      ...emptyAppInfo("tautulli", openUrl),
      configured: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Try FileFlows Server HTTP API for version; fall back to local DLL.
 * @param {string} baseUrl
 * @param {{ version?: string|null, path?: string|null }} local
 */
async function fetchFileFlowsServerInfo(baseUrl, local = {}) {
  const base = normalizeBase(baseUrl);
  const openUrl = base ? `${base}/` : null;
  const localVer = shortAppVersion(local.version);

  if (base) {
    const candidates = [
      `${base}/api/status`,
      `${base}/api/system/info`,
      `${base}/api/version`,
    ];
    for (const url of candidates) {
      try {
        const data = await fetchJson(url, { headers: { Accept: "application/json" } }, 4000);
        const installed = shortAppVersion(
          data?.Version ||
            data?.version ||
            data?.ServerVersion ||
            data?.serverVersion ||
            data?.data?.Version ||
            data?.data?.version ||
            "",
        );
        if (installed) {
          return {
            id: "fileflows",
            label: SERVICE_LABELS.fileflows,
            configured: true,
            ok: true,
            version: installed,
            updateAvailable: false,
            latestVersion: null,
            openUrl,
            source: "api",
          };
        }
      } catch {
        // try next
      }
    }
  }

  if (localVer) {
    return {
      id: "fileflows",
      label: SERVICE_LABELS.fileflows,
      configured: true,
      ok: true,
      version: localVer,
      updateAvailable: false,
      latestVersion: null,
      openUrl,
      source: "local",
    };
  }

  return emptyAppInfo("fileflows", openUrl);
}

/**
 * Merge API / Companion local version rows for companion PC apps.
 * @param {object[]} fromApis
 * @param {Array<{id:string,version?:string|null,label?:string}>} fromCompanion
 */
function mergeCompanionAppRows(fromApis, fromCompanion) {
  const byId = new Map();
  for (const row of fromApis) {
    if (row?.id) byId.set(row.id, row);
  }
  for (const local of fromCompanion || []) {
    const id = local?.id;
    if (!id) continue;
    const existing = byId.get(id);
    const localVer = shortAppVersion(local.version);
    if (!existing) {
      byId.set(id, {
        id,
        label: SERVICE_LABELS[id] || local.label || id,
        configured: Boolean(localVer),
        ok: Boolean(localVer),
        version: localVer || null,
        updateAvailable: false,
        latestVersion: null,
        openUrl: null,
        source: "companion",
      });
      continue;
    }
    if (!existing.version && localVer) {
      existing.version = localVer;
      existing.ok = true;
      existing.configured = true;
      existing.source = existing.source || "companion";
    }
  }

  // Apply GitHub update checks where we have a public feed.
  const withUpdates = [];
  for (const id of COMPANION_APP_ORDER) {
    const row = byId.get(id);
    if (!row) continue;
    withUpdates.push(row);
  }
  // Include any unexpected ids from companion.
  for (const [id, row] of byId) {
    if (!COMPANION_APP_ORDER.includes(id)) withUpdates.push(row);
  }
  return withUpdates;
}

async function applyCompanionGithubUpdates(apps) {
  const latestById = {
    qbittorrent: await githubLatestVersion("qbittorrent/qBittorrent"),
    sabnzbd: await githubLatestVersion("sabnzbd/sabnzbd"),
  };
  return apps.map((row) => {
    if (row.id === "qbittorrent" || row.id === "sabnzbd") {
      if (row.updateAvailable) return row;
      return withGithubUpdate(row, latestById[row.id]);
    }
    return row;
  });
}

/**
 * @param {{ urls?: Record<string, string>, hubVersion?: string }} opts
 */
export async function getChipAppVersions(opts = {}) {
  const urls = opts.urls || {};
  const settings = loadWatchdogSettings();
  const integrations = loadIntegrationsSettings();
  const tautulli = loadTautulliSettings();
  const companionPc =
    (settings.pcs || []).find((pc) => String(pc.companionUrl || "").trim()) ||
    null;

  const arrTargets = ARR_IDS.filter((id) => {
    const url = normalizeBase(urls[id]);
    const key = getArrApiKey(id);
    return Boolean(url) || Boolean(key);
  });
  // Prefer a stable display order matching the dashboard services list.
  const arrOrder = [
    "sonarr",
    "radarr",
    "lidarr",
    "readarr",
    "prowlarr",
    "bazarr",
    "whisparr",
  ];
  arrTargets.sort(
    (a, b) =>
      (arrOrder.indexOf(a) === -1 ? 99 : arrOrder.indexOf(a)) -
      (arrOrder.indexOf(b) === -1 ? 99 : arrOrder.indexOf(b)),
  );

  const qbitUrl = normalizeBase(
    urls.qbittorrent || integrations.qbittorrent?.baseUrl,
  );
  const sabUrl = normalizeBase(urls.sabnzbd || integrations.sabnzbd?.baseUrl);
  const tautulliUrl = normalizeBase(urls.tautulli || tautulli.baseUrl);
  const fileflowsUrl = normalizeBase(urls.fileflows || "");

  const [
    arrs,
    qbit,
    sab,
    tautulliInfo,
    hubLocals,
    companionHealth,
    companionLocals,
  ] = await Promise.all([
    Promise.all(
      arrTargets.map((id) =>
        fetchArrUpdateInfo(id, urls[id], getArrApiKey(id)),
      ),
    ),
    fetchQbitVersion(
      qbitUrl,
      integrations.qbittorrent?.username || "",
      integrations.qbittorrent?.password || "",
    ),
    fetchSabVersion(sabUrl, integrations.sabnzbd?.apiKey || ""),
    fetchTautulliUpdateInfo(tautulliUrl, tautulli.apiKey || ""),
    getHubLocalFileFlowsVersions(),
    companionPc?.companionUrl
      ? checkCompanionHealth(
          companionPc.companionUrl,
          companionPc.companionApiKey || "",
        )
      : Promise.resolve(null),
    companionPc?.companionUrl
      ? requestCompanionLocalAppVersions(
          companionPc.companionUrl,
          companionPc.companionApiKey || "",
        )
      : Promise.resolve({ ok: false, apps: [] }),
  ]);

  const fileflowsHub = await fetchFileFlowsServerInfo(
    fileflowsUrl,
    hubLocals.fileflows || {},
  );

  // Hub popover list: *arr + Tautulli + FileFlows Server (on this PC).
  const hubApps = [...arrs];
  if (tautulliInfo.configured || tautulliInfo.ok) {
    hubApps.push(tautulliInfo);
  }
  if (fileflowsHub.configured || fileflowsHub.ok) {
    hubApps.push(fileflowsHub);
  } else if (shortAppVersion(hubLocals["fileflows-node"]?.version)) {
    hubApps.push({
      id: "fileflows-node",
      label: SERVICE_LABELS["fileflows-node"],
      configured: true,
      ok: true,
      version: shortAppVersion(hubLocals["fileflows-node"].version),
      updateAvailable: false,
      latestVersion: null,
      openUrl: null,
      source: "local",
    });
  }

  const companionVersion = shortAppVersion(companionHealth?.version) || null;
  let companionApps = mergeCompanionAppRows(
    [qbit, sab],
    companionLocals?.apps || [],
  );
  companionApps = await applyCompanionGithubUpdates(companionApps);

  const hubUpdatesAvailable = hubApps.filter((entry) => entry.updateAvailable);
  const companionUpdatesAvailable = companionApps.filter(
    (entry) => entry.updateAvailable,
  );

  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    hub: {
      version: shortAppVersion(opts.hubVersion) || null,
      arrUpdateCount: hubUpdatesAvailable.length,
    },
    arrs: hubApps,
    companion: companionPc
      ? {
          pcId: companionPc.id,
          name: companionPc.name || "Companion",
          version: companionVersion,
          appUpdateCount: companionUpdatesAvailable.length,
          apps: companionApps,
        }
      : null,
  };
}
