/**
 * Plex Media Server update check + install (Windows PMS on the hub PC).
 *
 * Prefers PMS native updater APIs (same as Plex Settings -> Updates):
 *   PUT  /updater/check?download=0|1
 *   GET  /updater/status
 *   PUT  /updater/apply?tonight=0|1
 *
 * Mobile / desktop UI both call hub routes; install only works when hub
 * runs on the PMS machine and PMS reports canInstall.
 */
import { getPlexClientId, getWorkoutConfig } from "./plex.mjs";
import { normalizePlexBaseUrl } from "./workout-store.mjs";

const PLEX_PRODUCT = "Arrs Hub";

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
  const release = asArray(container.Release)[0] ?? null;
  if (!release) return null;
  return {
    version: release.version ? String(release.version) : null,
    state: release.state ? String(release.state) : null,
    downloadURL: release.downloadURL ? String(release.downloadURL) : null,
    key: release.key ? String(release.key) : null,
  };
}

/**
 * @param {{ refresh?: boolean }} [options]
 */
export async function getPlexUpdateStatus(options = {}) {
  const { settings, token } = requirePlexToken();
  const baseUrl = settings.plexBaseUrl;
  const checkedAtIso = new Date().toISOString();

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

  if (options.refresh) {
    try {
      await updaterFetch(baseUrl, token, "/updater/check", {
        method: "PUT",
        query: { download: 0 },
      });
    } catch {
      // status endpoint may still have a cached result
    }
  }

  try {
    const statusJson = await updaterFetch(baseUrl, token, "/updater/status");
    const container = mediaContainer(statusJson);
    const release = releaseFromStatus(container);
    const latestVersion = release?.version ?? null;
    const canInstall = boolish(container.canInstall);
    const lastCheckedEpoch = Number(container.checkedAt);
    const lastChecked = Number.isFinite(lastCheckedEpoch) && lastCheckedEpoch > 0
      ? new Date(lastCheckedEpoch * 1000).toISOString()
      : checkedAtIso;

    const updateAvailable = Boolean(
      latestVersion &&
        installedVersion &&
        latestVersion !== installedVersion &&
        release?.state !== "skipped",
    );

    return {
      ok: true,
      installedVersion,
      latestVersion,
      updateAvailable,
      channel: null,
      canInstall,
      releaseState: release?.state ?? null,
      downloadURL: release?.downloadURL || container.downloadURL || null,
      lastChecked,
      platform: process.platform,
      error: null,
      job: getPlexUpdateJob(),
    };
  } catch (err) {
    return {
      ok: true,
      installedVersion,
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
