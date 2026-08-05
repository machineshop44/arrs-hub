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
 * Install paths:
 *   - Prefer PMS PUT /updater/apply when PMS lists a Release and canInstall.
 *   - Else on win32 when hub is local to PMS: download the plex.tv Windows
 *     installer and run it silently (/VERYSILENT /NORESTART). UAC may still
 *     prompt depending on how PMS was installed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DATA_DIR, ensureDataDirs } from "./config.mjs";
import { getPlexClientId, getWorkoutConfig } from "./plex.mjs";
import { normalizePlexBaseUrl } from "./workout-store.mjs";

const PLEX_PRODUCT = "Arrs Hub";
const DOWNLOADS_JSON_URL = "https://plex.tv/api/downloads/5.json";
const PLEX_TV_CACHE_TTL_MS = 5 * 60 * 1000;
const PLEX_UPDATE_DIR = path.join(DATA_DIR, "plex-updates");

/** @typedef {'idle'|'checking'|'downloading'|'applying'|'done'|'error'} PlexUpdateJobPhase */
/** @typedef {'pms'|'windows-installer'|null} PlexInstallMethod */

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
 * True when plexBaseUrl points at this machine (hub can run the Windows installer).
 * @param {string} baseUrl
 */
export function isPlexHostLocalToHub(baseUrl) {
  let hostname = "";
  try {
    hostname = new URL(normalizePlexBaseUrl(baseUrl)).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!hostname) return false;
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  ) {
    return true;
  }

  const localNames = new Set(
    [os.hostname(), `${os.hostname()}.local`]
      .filter(Boolean)
      .map((name) => name.toLowerCase()),
  );
  if (localNames.has(hostname)) return true;

  const ifaces = os.networkInterfaces();
  for (const entries of Object.values(ifaces)) {
    for (const entry of entries || []) {
      if (!entry?.address) continue;
      if (entry.address.toLowerCase() === hostname) return true;
    }
  }
  return false;
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
 * Precise reason Install is blocked (when updateAvailable && !canInstall).
 * @param {{
 *   updateAvailable: boolean,
 *   canInstallViaPms: boolean,
 *   pmsListsNewer: boolean,
 *   canInstallFromPms: boolean,
 *   channel: string|null,
 *   downloadURL: string|null,
 *   hubLocal: boolean,
 *   platform: string,
 * }} ctx
 */
function blockedInstallReason(ctx) {
  if (!ctx.updateAvailable) return null;
  if (ctx.canInstallViaPms) return null;

  if (ctx.pmsListsNewer && !ctx.canInstallFromPms) {
    return "PMS lists this Release but canInstall=false (manual/NAS/Docker installs cannot use /updater/apply — update on the PMS host).";
  }

  if (ctx.channel === "plex.tv" || !ctx.pmsListsNewer) {
    if (ctx.platform !== "win32") {
      return `Update listed on plex.tv, but Arrs Hub auto-install (Windows installer) only runs on win32 (hub is ${ctx.platform}). Use Plex Settings → Updates on the PMS host.`;
    }
    if (!ctx.hubLocal) {
      return "Update listed on plex.tv, but hub is not on the PMS PC (plexBaseUrl is remote). Set Plex URL to localhost on the PMS host, or update from Plex Settings there.";
    }
    if (!ctx.downloadURL) {
      return "Update listed on plex.tv, but no Windows download URL was found — update from Plex Settings → Updates on the PMS host.";
    }
    return "Update listed on plex.tv, but PMS /updater/status has no installable Release yet — use Plex Settings → Updates, or wait for the server updater to list it.";
  }

  return "Plex reports canInstall=false — update on the PMS host.";
}

/**
 * Download plex.tv Windows installer and run silent upgrade.
 * @param {PlexUpdateJob} job
 * @param {{ downloadURL: string, version: string }} opts
 */
async function runWindowsInstallerUpdate(job, opts) {
  ensureDataDirs();
  fs.mkdirSync(PLEX_UPDATE_DIR, { recursive: true });

  const safeVer = normalizePlexVersion(opts.version).replace(/[^\w.-]+/g, "_");
  const fileName = `PlexMediaServer-${safeVer}-x86_64.exe`;
  const installerPath = path.join(PLEX_UPDATE_DIR, fileName);

  job.phase = "downloading";
  job.progress = 25;
  job.message = `Downloading Plex ${normalizePlexVersion(opts.version)} installer…`;

  const res = await fetch(opts.downloadURL, {
    headers: { "User-Agent": "Arrs-Hub", Accept: "*/*" },
    redirect: "follow",
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download Plex installer (HTTP ${res.status}).`);
  }

  await pipeline(Readable.fromWeb(res.body), createWriteStream(installerPath));

  const size = fs.statSync(installerPath).size;
  if (size < 1_000_000) {
    throw new Error(
      `Downloaded installer looks too small (${size} bytes) — aborting.`,
    );
  }

  job.phase = "applying";
  job.progress = 70;
  job.message =
    "Running Windows Plex installer (silent). PMS will restart; UAC may prompt.";

  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(
      installerPath,
      ["/VERYSILENT", "/NORESTART", "/SUPPRESSMSGBOXES"],
      {
        windowsHide: true,
        detached: false,
      },
    );
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });

  try {
    fs.unlinkSync(installerPath);
  } catch {
    // leave file if locked mid-install
  }

  if (exitCode !== 0) {
    throw new Error(
      `Plex Windows installer exited with code ${exitCode}. If UAC blocked it, run the update from an elevated Arrs Hub or Plex Settings → Updates.`,
    );
  }

  job.phase = "done";
  job.progress = 100;
  job.message =
    "Windows installer finished. Plex Media Server may restart shortly.";
  job.finishedAt = new Date().toISOString();
  job.result = {
    updateAvailable: true,
    canInstall: true,
    installMethod: "windows-installer",
    applied: true,
    version: opts.version,
  };
}

/**
 * @param {{ refresh?: boolean }} [options]
 */
export async function getPlexUpdateStatus(options = {}) {
  const { settings, token } = requirePlexToken();
  const baseUrl = settings.plexBaseUrl;
  const checkedAtIso = new Date().toISOString();
  const refresh = Boolean(options.refresh);
  const hubLocal = isPlexHostLocalToHub(baseUrl);
  const platform = process.platform;

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
      installMethod: null,
      releaseState: null,
      lastChecked: checkedAtIso,
      platform,
      hubLocal,
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
  let downloadURL = pmsRelease?.downloadURL || null;
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

  // Prefer plex.tv Windows URL when channel is catalog (PMS downloadURL may be empty).
  if (channel === "plex.tv" && plexTv.downloadURL) {
    downloadURL = plexTv.downloadURL;
  }

  const updateAvailable = Boolean(
    latestVersion &&
      installedVersion &&
      comparePlexVersions(installedVersion, latestVersion) < 0 &&
      releaseState !== "skipped",
  );

  const pmsListsNewer = Boolean(
    pmsRelease?.version &&
      installedVersion &&
      comparePlexVersions(installedVersion, pmsRelease.version) < 0 &&
      pmsRelease.state !== "skipped",
  );
  const plexTvAheadOfPms = Boolean(
    plexTv.version &&
      (!pmsRelease?.version ||
        comparePlexVersions(pmsRelease.version, plexTv.version) < 0),
  );
  const canInstallViaPms = Boolean(
    canInstallFromPms && pmsListsNewer && !plexTvAheadOfPms,
  );
  const canInstallViaWindows = Boolean(
    updateAvailable &&
      platform === "win32" &&
      hubLocal &&
      Boolean(downloadURL) &&
      (plexTvAheadOfPms || !canInstallFromPms || !pmsListsNewer),
  );
  const canInstall = canInstallViaPms || canInstallViaWindows;
  /** @type {PlexInstallMethod} */
  const installMethod = canInstallViaWindows
    ? "windows-installer"
    : canInstallViaPms
      ? "pms"
      : null;

  /** @type {string|null} */
  let error = null;
  if (updateAvailable && !canInstall) {
    error = blockedInstallReason({
      updateAvailable,
      canInstallViaPms,
      pmsListsNewer,
      canInstallFromPms,
      channel,
      downloadURL,
      hubLocal,
      platform,
    });
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
    installMethod,
    releaseState,
    downloadURL,
    lastChecked,
    platform,
    hubLocal,
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
    const hubLocal = isPlexHostLocalToHub(baseUrl);

    job.phase = "checking";
    job.progress = 15;
    job.message = opts.download
      ? "Checking for updates and downloading…"
      : "Checking for updates…";

    try {
      await updaterFetch(baseUrl, token, "/updater/check", {
        method: "PUT",
        query: { download: opts.download ? 1 : 0 },
      });
    } catch {
      // PMS check can fail while plex.tv fallback still works.
    }

    let release = null;
    let canInstallFromPms = false;
    try {
      const statusJson = await updaterFetch(baseUrl, token, "/updater/status");
      const container = mediaContainer(statusJson);
      release = releaseFromStatus(container);
      canInstallFromPms = boolish(container.canInstall);
    } catch {
      release = null;
    }

    let installed = null;
    try {
      const identity = await updaterFetch(baseUrl, token, "/identity");
      const idVer = mediaContainer(identity).version;
      installed = idVer ? String(idVer) : null;
    } catch {
      // keep null
    }

    const pmsListsNewer = Boolean(
      release?.version &&
        installed &&
        comparePlexVersions(installed, release.version) < 0 &&
        release.state !== "skipped",
    );

    // plex.tv / Windows installer fallback (prefer when catalog is ahead of PMS Release)
    const plexTv = await fetchPlexTvLatestWindows({ force: true });
    const plexTvNewer = Boolean(
      plexTv.version &&
        installed &&
        comparePlexVersions(installed, plexTv.version) < 0,
    );
    const plexTvAheadOfPms = Boolean(
      plexTv.version &&
        (!release?.version ||
          comparePlexVersions(release.version, plexTv.version) < 0),
    );
    const windowsUrl = plexTv.downloadURL || release?.downloadURL || null;
    const preferWindows =
      plexTvNewer &&
      plexTvAheadOfPms &&
      process.platform === "win32" &&
      hubLocal &&
      Boolean(windowsUrl);

    if (pmsListsNewer && canInstallFromPms && !preferWindows) {
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
          canInstall: true,
          installMethod: "pms",
          release,
        };
        return;
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
        canInstall: true,
        installMethod: "pms",
        release,
        applied: true,
        tonight: opts.tonight,
      };
      return;
    }

    if (!plexTvNewer && !pmsListsNewer) {
      job.phase = "done";
      job.progress = 100;
      job.message = "Plex is up to date (no release available).";
      job.finishedAt = new Date().toISOString();
      job.result = { updateAvailable: false, canInstall: false, release };
      return;
    }

    if (!opts.apply) {
      job.phase = "done";
      job.progress = 100;
      job.message = plexTvNewer
        ? `Update ${normalizePlexVersion(plexTv.version)} available via plex.tv (apply skipped).`
        : "Update check finished (apply skipped).";
      job.finishedAt = new Date().toISOString();
      job.result = {
        updateAvailable: true,
        canInstall: Boolean(
          process.platform === "win32" && hubLocal && windowsUrl,
        ),
        installMethod:
          process.platform === "win32" && hubLocal && windowsUrl
            ? "windows-installer"
            : null,
        release,
        plexTvVersion: plexTv.version,
      };
      return;
    }

    if (opts.tonight) {
      throw new Error(
        "Schedule for tonight only works with PMS /updater/apply. Install now (Windows installer) instead, or wait until PMS lists the Release.",
      );
    }

    if (process.platform !== "win32") {
      throw new Error(
        `Plex Media Server updater has no installable Release, and Arrs Hub Windows installer fallback requires win32 (hub is ${process.platform}). Update from Plex Settings on the PMS host.`,
      );
    }
    if (!hubLocal) {
      throw new Error(
        "Plex Media Server updater has no installable Release, and hub is not on the PMS PC (plexBaseUrl is remote). Set Plex URL to localhost on the PMS host, or update from Plex Settings there.",
      );
    }
    if (!windowsUrl || !plexTv.version) {
      throw new Error(
        "Plex Media Server updater has no Release and plex.tv did not provide a Windows download URL. Update from Plex Settings → Updates on the PMS host.",
      );
    }

    await runWindowsInstallerUpdate(job, {
      downloadURL: windowsUrl,
      version: plexTv.version,
    });
  } catch (err) {
    job.phase = "error";
    job.progress = 100;
    job.error = err?.message || String(err);
    job.message = "Plex update failed.";
    job.finishedAt = new Date().toISOString();
  }
}
