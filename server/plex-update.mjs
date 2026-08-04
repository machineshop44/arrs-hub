/**
 * Plex Media Server update check + install (Windows PMS on the hub PC).
 *
 * Detection combines:
 *   1) PMS native updater APIs (same as Plex Settings → Updates):
 *        PUT  /updater/check?download=0|1
 *        GET  /updater/status
 *        PUT  /updater/apply?tonight=0|1
 *   2) plex.tv downloads catalog (https://plex.tv/api/downloads/5.json)
 *      — PMS /updater/status often lags or returns size=0 even when plex.tv
 *        already lists a newer build (e.g. 1.43.3.10828 installed vs
 *        1.43.3.10861 on plex.tv). Without the catalog fallback the hub
 *        falsely reports "up to date".
 *
 * Install still uses PMS /updater/apply when PMS lists a Release and
 * canInstall=true. Catalog-only updates set canInstall=false with a clear
 * channel hint so the UI does not offer a no-op Install.
 */
import { getPlexClientId, getWorkoutConfig } from "./plex.mjs";
import { normalizePlexBaseUrl } from "./workout-store.mjs";

const PLEX_PRODUCT = "Arrs Hub";
const DOWNLOADS_JSON_URL = "https://plex.tv/api/downloads/5.json";
const PLEX_TV_CACHE_TTL_MS = 5 * 60 * 1000;

/** @typedef {'idle'|'checking'|'downloading'|'applying'|'done'|'error'} PlexUpdateJobPhase */

/**
 * @typedef {object} PlexUpdateJob
 * @property {string} id
 * @property {PlexUpdateJobPhase} phase
 * @property {number} progress
 * @property {string} message
 * @property {string|null} error
 * @property {string} startedAt
 * @property {string|null} finishedAt
 * @property {object|null} result
 */

/** @type {PlexUpdateJob|null} */
let currentJob = null;
let jobSeq = 0;

/** @type {{ fetchedAt: number, version: string|null, downloadURL: string|null, error: string|null } | null} */
let plexTvCache = null;

function plexHeaders(token) {
  return {
    Accept: "application/json",
    "X-Plex-Product": PLEX_PRODUCT,
    "X-Plex-Client-Identifier": getPlexClientId(),
    "X-Plex-Device-Name": PLEX_PRODUCT,
    "X-Plex-Platform": "Windows",
    "X-Plex-Device": "PC",
    "X-Plex-Token": token,
  };
}

/**
 * Normalize PMS version strings for comparison.
 * e.g. "1.43.3.10861-07dfddaeb" → "1.43.3.10861"
 */
export function normalizePlexVersion(version) {
  const raw = String(version || "").trim();
  if (!raw) return "";
  return raw.split("-")[0].trim();
}

/**
 * Compare dotted numeric versions. Returns -1 / 0 / 1.
 * @param {string} a
 * @param {string} b
 */
export function comparePlexVersions(a, b) {
  const left = normalizePlexVersion(a)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const right = normalizePlexVersion(b)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l < r) return -1;
    if (l > r) return 1;
  }
  return 0;
}

/**
 * @param {string} baseUrl
 * @param {string} token
 * @param {string} apiPath
 * @param {{ method?: string, query?: Record<string, string|number|boolean|undefined|null> }} [options]
 */
async function updaterFetch(baseUrl, token, apiPath, options = {}) {
  const url = new URL(apiPath, `${normalizePlexBaseUrl(baseUrl)}/`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  if (token) url.searchParams.set("X-Plex-Token", token);

  const res = await fetch(url, {
    method: options.method || "GET",
    headers: plexHeaders(token),
    signal: AbortSignal.timeout(30000),
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    const detail =
      json?.error ||
      json?.message ||
      text.slice(0, 240) ||
      `HTTP ${res.status}`;
    throw new Error(`Plex ${apiPath} failed: ${detail}`);
  }

  return json;
}

function mediaContainer(json) {
  return json?.MediaContainer ?? json ?? {};
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function boolish(value) {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return Boolean(value);
}

/**
 * @param {ReturnType<typeof getWorkoutConfig>} [settings]
 */
function requirePlexToken(settings = getWorkoutConfig()) {
  const token = settings.plexToken?.trim();
  if (!token) {
    throw new Error("Sign in with Plex in Arrs Hub first (Workouts / Plex auth).");
  }
  return { settings, token };
}

/**
 * @param {object} container
 */
function releaseFromStatus(container) {
  const releases = asArray(container.Release).filter(Boolean);
  if (!releases.length) return null;

  // Prefer an actionable / newer-looking release when PMS returns several.
  let best = releases[0];
  for (const release of releases.slice(1)) {
    const bestVer = best?.version ? String(best.version) : "";
    const nextVer = release?.version ? String(release.version) : "";
    if (nextVer && (!bestVer || comparePlexVersions(nextVer, bestVer) > 0)) {
      best = release;
    }
  }

  return {
    version: best.version ? String(best.version) : null,
    state: best.state ? String(best.state) : null,
    downloadURL: best.downloadURL ? String(best.downloadURL) : null,
    key: best.key ? String(best.key) : null,
  };
}

/**
 * @param {{ force?: boolean }} [options]
 */
async function fetchPlexTvLatestWindows(options = {}) {
  const force = Boolean(options.force);
  const now = Date.now();
  if (
    !force &&
    plexTvCache &&
    now - plexTvCache.fetchedAt < PLEX_TV_CACHE_TTL_MS &&
    (plexTvCache.version || plexTvCache.error)
  ) {
    return plexTvCache;
  }

  try {
    const res = await fetch(DOWNLOADS_JSON_URL, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Arrs-Hub",
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      throw new Error(`plex.tv downloads HTTP ${res.status}`);
    }
    const json = await res.json();
    const windows = json?.computer?.Windows;
    const version = String(windows?.version || "").trim() || null;
    const releases = Array.isArray(windows?.releases) ? windows.releases : [];
    const x64 =
      releases.find(
        (item) =>
          String(item?.build || "").toLowerCase() === "windows-x86_64" ||
          String(item?.url || "").includes("x86_64"),
      ) ||
      releases.find((item) =>
        String(item?.url || "").toLowerCase().endsWith(".exe"),
      );
    const downloadURL = x64?.url ? String(x64.url) : null;
    if (!version) {
      throw new Error("plex.tv downloads JSON missing Windows version.");
    }
    plexTvCache = {
      fetchedAt: now,
      version,
      downloadURL,
      error: null,
    };
    return plexTvCache;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (plexTvCache?.version) {
      return {
        ...plexTvCache,
        error: `Using cached plex.tv latest (${message})`,
      };
    }
    plexTvCache = {
      fetchedAt: now,
      version: null,
      downloadURL: null,
      error: message,
    };
    return plexTvCache;
  }
}

/**
 * @param {{ refresh?: boolean }} [options]
 */
export async function getPlexUpdateStatus(options = {}) {
  const { settings, token } = requirePlexToken();
  const baseUrl = settings.plexBaseUrl;
  const checkedAtIso = new Date().toISOString();
  const refresh = Boolean(options.refresh);

  let installedVersion = null;
  try {
    const identity = await updaterFetch(baseUrl, token, "/identity");
    const idContainer = mediaContainer(identity);
    installedVersion = idContainer.version
      ? String(idContainer.version)
      : null;
  } catch (err) {
    return {
      ok: false,
      installedVersion: null,
      latestVersion: null,
      updateAvailable: false,
      channel: null,
      canInstall: false,
      releaseState: null,
      lastChecked: checkedAtIso,
      platform: process.platform,
      error: err?.message || String(err),
      job: getPlexUpdateJob(),
    };
  }

  /** @type {ReturnType<typeof releaseFromStatus>} */
  let pmsRelease = null;
  let canInstallFromPms = false;
  let lastChecked = checkedAtIso;
  /** @type {string|null} */
  let pmsStatusError = null;

  if (refresh) {
    try {
      await updaterFetch(baseUrl, token, "/updater/check", {
        method: "PUT",
        query: { download: 0 },
      });
    } catch (err) {
      pmsStatusError = err?.message || String(err);
    }
  }

  try {
    const statusJson = await updaterFetch(baseUrl, token, "/updater/status");
    const container = mediaContainer(statusJson);
    pmsRelease = releaseFromStatus(container);
    canInstallFromPms = boolish(container.canInstall);
    const lastCheckedEpoch = Number(container.checkedAt);
    if (Number.isFinite(lastCheckedEpoch) && lastCheckedEpoch > 0) {
      lastChecked = new Date(lastCheckedEpoch * 1000).toISOString();
    }
  } catch (err) {
    pmsStatusError = err?.message || String(err);
  }

  const plexTv = await fetchPlexTvLatestWindows({ force: refresh });

  let latestVersion = pmsRelease?.version ?? null;
  let downloadURL =
    pmsRelease?.downloadURL || null;
  let releaseState = pmsRelease?.state ?? null;
  /** @type {string|null} */
  let channel = pmsRelease?.version ? "pms" : null;

  if (plexTv.version) {
    if (
      !latestVersion ||
      comparePlexVersions(plexTv.version, latestVersion) > 0
    ) {
      latestVersion = plexTv.version;
      if (!downloadURL) downloadURL = plexTv.downloadURL;
      if (!releaseState) releaseState = "available";
      channel = "plex.tv";
    } else if (!channel) {
      channel = "plex.tv";
    }
  }

  const updateAvailable = Boolean(
    latestVersion &&
      installedVersion &&
      comparePlexVersions(installedVersion, latestVersion) < 0 &&
      releaseState !== "skipped",
  );

  // Install via hub only when PMS updater itself lists a newer Release.
  const pmsListsNewer = Boolean(
    pmsRelease?.version &&
      installedVersion &&
      comparePlexVersions(installedVersion, pmsRelease.version) < 0 &&
      pmsRelease.state !== "skipped",
  );
  const canInstall = Boolean(canInstallFromPms && pmsListsNewer);

  /** @type {string|null} */
  let error = null;
  if (updateAvailable && !pmsListsNewer) {
    error =
      "Update listed on plex.tv, but PMS /updater/status has no Release yet — use Plex Settings → Updates, or wait for the server updater to list it.";
  } else if (!updateAvailable && pmsStatusError && !latestVersion) {
    error = pmsStatusError;
  } else if (plexTv.error && !latestVersion) {
    error = plexTv.error;
  }

  return {
    ok: true,
    installedVersion,
    latestVersion,
    updateAvailable,
    channel,
    canInstall,
    releaseState,
    downloadURL,
    lastChecked,
    platform: process.platform,
    error,
    job: getPlexUpdateJob(),
  };
}

export function getPlexUpdateJob() {
  return currentJob
    ? { ...currentJob }
    : {
        id: null,
        phase: "idle",
        progress: 0,
        message: "No update job running.",
        error: null,
        startedAt: null,
        finishedAt: null,
        result: null,
      };
}

/**
 * @param {{ download?: boolean, apply?: boolean, tonight?: boolean }} [body]
 */
export function startPlexUpdateJob(body = {}) {
  if (currentJob && ["checking", "downloading", "applying"].includes(currentJob.phase)) {
    const err = new Error("A Plex update job is already running.");
    err.code = "JOB_IN_PROGRESS";
    throw err;
  }

  const download = body.download !== false;
  const apply = body.apply !== false;
  const tonight = Boolean(body.tonight);

  jobSeq += 1;
  /** @type {PlexUpdateJob} */
  const job = {
    id: `plex-update-${Date.now()}-${jobSeq}`,
    phase: "checking",
    progress: 5,
    message: "Starting Plex update…",
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    result: null,
  };
  currentJob = job;

  void runUpdateJob(job, { download, apply, tonight });
  return getPlexUpdateJob();
}

/**
 * @param {PlexUpdateJob} job
 * @param {{ download: boolean, apply: boolean, tonight: boolean }} opts
 */
async function runUpdateJob(job, opts) {
  try {
    const { settings, token } = requirePlexToken();
    const baseUrl = settings.plexBaseUrl;

    job.phase = "checking";
    job.progress = 15;
    job.message = opts.download
      ? "Checking for updates and downloading…"
      : "Checking for updates…";

    await updaterFetch(baseUrl, token, "/updater/check", {
      method: "PUT",
      query: { download: opts.download ? 1 : 0 },
    });

    const statusJson = await updaterFetch(baseUrl, token, "/updater/status");
    const container = mediaContainer(statusJson);
    const release = releaseFromStatus(container);
    const canInstall = boolish(container.canInstall);

    if (!release?.version) {
      // Cross-check plex.tv so the job error is actionable when updater lags.
      const plexTv = await fetchPlexTvLatestWindows({ force: true });
      let installed = null;
      try {
        const identity = await updaterFetch(baseUrl, token, "/identity");
        const idVer = mediaContainer(identity).version;
        installed = idVer ? String(idVer) : null;
      } catch {
        // keep null
      }
      if (
        plexTv.version &&
        installed &&
        comparePlexVersions(installed, plexTv.version) < 0
      ) {
        throw new Error(
          `Plex Media Server updater has no Release, but plex.tv lists ${normalizePlexVersion(plexTv.version)} (installed ${normalizePlexVersion(installed)}). Update from Plex Settings → Updates on the PMS host.`,
        );
      }
      job.phase = "done";
      job.progress = 100;
      job.message = "Plex is up to date (no release available).";
      job.finishedAt = new Date().toISOString();
      job.result = { updateAvailable: false, canInstall, release: null };
      return;
    }

    if (opts.download) {
      job.phase = "downloading";
      job.progress = 45;
      job.message = `Update ${release.version} state: ${release.state || "unknown"}`;
    }

    if (!opts.apply) {
      job.phase = "done";
      job.progress = 100;
      job.message = "Update check finished (apply skipped).";
      job.finishedAt = new Date().toISOString();
      job.result = {
        updateAvailable: true,
        canInstall,
        release,
      };
      return;
    }

    if (!canInstall) {
      throw new Error(
        "Plex reports canInstall=false. Manual/NAS installs cannot be applied from Arrs Hub — update on the PMS host, or use Windows PMS with updater support.",
      );
    }

    job.phase = "applying";
    job.progress = 70;
    job.message = opts.tonight
      ? "Scheduling update for tonight (Butler)…"
      : "Applying Plex update now (server may restart)…";

    await updaterFetch(baseUrl, token, "/updater/apply", {
      method: "PUT",
      query: { tonight: opts.tonight ? 1 : 0 },
    });

    job.phase = "done";
    job.progress = 100;
    job.message = opts.tonight
      ? "Update scheduled for tonight."
      : "Update apply requested. Plex may restart shortly.";
    job.finishedAt = new Date().toISOString();
    job.result = {
      updateAvailable: true,
      canInstall,
      release,
      applied: true,
      tonight: opts.tonight,
    };
  } catch (err) {
    job.phase = "error";
    job.progress = 100;
    job.error = err?.message || String(err);
    job.message = "Plex update failed.";
    job.finishedAt = new Date().toISOString();
  }
}
