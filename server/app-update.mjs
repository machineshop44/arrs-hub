/**
 * Click-to-update jobs for *arr apps (ApplicationUpdate), Tautulli (cmd=update),
 * and Companion-side qBit/SAB (winget via Companion).
 */
import { ARR_API_APP_IDS, getArrApiKey } from "./arr-api-keys.mjs";
import { loadSyncSettings } from "./config.mjs";
import {
  loadTautulliSettings,
  normalizeTautulliBaseUrl,
} from "./tautulli.mjs";
import { loadWatchdogSettings } from "./watchdog-store.mjs";
import {
  requestCompanionAppUpdate,
  requestCompanionAppUpdateStatus,
} from "./companion-client.mjs";

const ARR_UPDATE_IDS = ARR_API_APP_IDS.filter((id) => id !== "bazarr");
const COMPANION_UPDATE_IDS = ["qbittorrent", "sabnzbd"];

/** @type {Map<string, AppUpdateJob>} */
const jobsById = new Map();
/** @type {AppUpdateJob | null} */
let lastJob = null;
let jobSeq = 0;

/**
 * @typedef {{
 *   id: string,
 *   appId: string,
 *   label: string,
 *   phase: "idle"|"running"|"done"|"error",
 *   message: string,
 *   error: string|null,
 *   startedAt: string|null,
 *   finishedAt: string|null,
 * }} AppUpdateJob
 */

function normalizeBase(url) {
  return String(url || "")
    .trim()
    .replace(/\/+$/, "");
}

function arrApiVersion(id) {
  if (id === "lidarr" || id === "readarr" || id === "prowlarr") return "v1";
  return "v3";
}

const LABELS = {
  sonarr: "Sonarr",
  radarr: "Radarr",
  lidarr: "Lidarr",
  readarr: "Readarr",
  prowlarr: "Prowlarr",
  whisparr: "Whisparr",
  bazarr: "Bazarr",
  tautulli: "Tautulli",
  qbittorrent: "qBittorrent",
  sabnzbd: "SABnzbd",
};

export function supportedAppUpdateIds() {
  return [...ARR_UPDATE_IDS, "tautulli", ...COMPANION_UPDATE_IDS];
}

export function supportedCompanionAppUpdateIds() {
  return [...COMPANION_UPDATE_IDS];
}

function idleJob(appId = null) {
  return {
    id: null,
    appId: appId || null,
    label: appId ? LABELS[appId] || appId : null,
    phase: "idle",
    message: "No update job running.",
    error: null,
    startedAt: null,
    finishedAt: null,
  };
}

/**
 * @param {string|null|undefined} appId
 */
export function getAppUpdateJob(appId) {
  const id = String(appId || "").trim();
  if (id && jobsById.has(id)) {
    return { ...jobsById.get(id) };
  }
  if (lastJob && (!id || lastJob.appId === id)) {
    return { ...lastJob };
  }
  return idleJob(id || null);
}

function resolveArrBaseUrl(appId, urls = {}) {
  const fromClient = normalizeBase(urls[appId] || urls.baseUrl);
  if (fromClient) return fromClient;
  if (appId === "sonarr" || appId === "radarr") {
    const sync = loadSyncSettings();
    return normalizeBase(sync[appId]?.baseUrl);
  }
  return "";
}

function resolveTautulliBaseUrl(urls = {}) {
  const fromClient = normalizeBase(urls.tautulli || urls.baseUrl);
  if (fromClient) return normalizeTautulliBaseUrl(fromClient);
  return normalizeTautulliBaseUrl(loadTautulliSettings().baseUrl);
}

async function fetchJson(url, options = {}, timeoutMs = 20000) {
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
    throw new Error(typeof detail === "string" ? detail : `HTTP ${res.status}`);
  }
  return data;
}

async function runArrApplicationUpdate(appId, baseUrl, apiKey) {
  const base = normalizeBase(baseUrl);
  if (!base) throw new Error(`No URL configured for ${LABELS[appId] || appId}.`);
  if (!apiKey) {
    throw new Error(
      `No API key saved for ${LABELS[appId] || appId}. Add it in Settings → Apps & monitoring.`,
    );
  }
  const apiVer = arrApiVersion(appId);
  await fetchJson(
    `${base}/api/${apiVer}/command`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": apiKey,
        Accept: "application/json",
      },
      body: JSON.stringify({ name: "ApplicationUpdate" }),
    },
    30000,
  );
  return `${LABELS[appId] || appId} update command accepted — the app will download and restart itself.`;
}

async function runTautulliUpdate(baseUrl) {
  const settings = loadTautulliSettings();
  const base = normalizeTautulliBaseUrl(baseUrl || settings.baseUrl);
  const apiKey = String(settings.apiKey || "").trim();
  if (!base) throw new Error("No Tautulli URL configured.");
  if (!apiKey) {
    throw new Error(
      "No Tautulli API key saved. Add it in Settings → Apps & monitoring.",
    );
  }
  const data = await fetchJson(
    `${base}/api/v2?apikey=${encodeURIComponent(apiKey)}&cmd=update`,
    {},
    60000,
  );
  const resp = data?.response || data || {};
  if (resp.result === "error") {
    throw new Error(resp.message || "Tautulli update failed.");
  }
  return (
    resp.message ||
    "Tautulli update started — it may restart shortly."
  );
}

function pickCompanionPc(pcId) {
  const settings = loadWatchdogSettings();
  const pcs = settings.pcs || [];
  const wanted = String(pcId || "").trim();
  if (wanted) {
    const match = pcs.find((pc) => pc.id === wanted);
    if (!match) throw new Error("Companion PC not found.");
    return match;
  }
  const withUrl = pcs.find((pc) => String(pc.companionUrl || "").trim());
  if (!withUrl) {
    throw new Error(
      "No Companion PC configured. Register Companion under Settings → Apps & monitoring.",
    );
  }
  return withUrl;
}

async function runCompanionWingetUpdate(appId, pcId) {
  const pc = pickCompanionPc(pcId);
  const url = String(pc.companionUrl || "").trim();
  const key = String(pc.companionApiKey || "").trim();
  if (!url) throw new Error(`Companion URL missing on "${pc.name || "PC"}".`);
  if (!key) {
    throw new Error(
      `Companion API key missing on "${pc.name || "PC"}". Re-register Companion.`,
    );
  }

  const started = await requestCompanionAppUpdate(url, key, appId);
  if (!started.ok) {
    throw new Error(started.message || "Companion refused the update.");
  }

  for (let i = 0; i < 150; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const status = await requestCompanionAppUpdateStatus(url, key, appId);
    const phase = status.job?.phase;
    if (phase === "done") {
      return (
        status.job?.message ||
        `${LABELS[appId] || appId} update finished on ${pc.name || "Companion PC"}.`
      );
    }
    if (phase === "error") {
      throw new Error(
        status.job?.error ||
          status.job?.message ||
          `${LABELS[appId] || appId} update failed on Companion.`,
      );
    }
  }
  throw new Error(
    `${LABELS[appId] || appId} update is still running on Companion — check that PC.`,
  );
}

/**
 * @param {{ id: string, urls?: Record<string, string>, baseUrl?: string, pcId?: string }} body
 */
export function startAppUpdate(body = {}) {
  const appId = String(body.id || "").trim().toLowerCase();
  if (!appId) {
    const err = new Error("Missing app id.");
    err.code = "BAD_REQUEST";
    throw err;
  }

  if (appId === "bazarr") {
    const err = new Error(
      "Bazarr does not expose a remote update API — open Bazarr and update from its UI.",
    );
    err.code = "UNSUPPORTED";
    throw err;
  }

  if (!supportedAppUpdateIds().includes(appId)) {
    const err = new Error(
      `Click-to-update is not supported for ${LABELS[appId] || appId}.`,
    );
    err.code = "UNSUPPORTED";
    throw err;
  }

  const existing = jobsById.get(appId);
  if (existing && existing.phase === "running") {
    const err = new Error(`${LABELS[appId] || appId} update is already running.`);
    err.code = "JOB_IN_PROGRESS";
    throw err;
  }

  const urls = {
    ...(body.urls && typeof body.urls === "object" ? body.urls : {}),
  };
  if (body.baseUrl) urls.baseUrl = String(body.baseUrl);
  const pcId = String(body.pcId || "").trim();

  jobSeq += 1;
  /** @type {AppUpdateJob} */
  const job = {
    id: `app-update-${Date.now()}-${jobSeq}`,
    appId,
    label: LABELS[appId] || appId,
    phase: "running",
    message: COMPANION_UPDATE_IDS.includes(appId)
      ? `Asking Companion to update ${LABELS[appId] || appId}…`
      : `Starting ${LABELS[appId] || appId} update…`,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  jobsById.set(appId, job);
  lastJob = job;

  void (async () => {
    try {
      let message;
      if (COMPANION_UPDATE_IDS.includes(appId)) {
        message = await runCompanionWingetUpdate(appId, pcId);
      } else if (appId === "tautulli") {
        message = await runTautulliUpdate(resolveTautulliBaseUrl(urls));
      } else {
        message = await runArrApplicationUpdate(
          appId,
          resolveArrBaseUrl(appId, urls),
          getArrApiKey(appId),
        );
      }
      job.phase = "done";
      job.message = message;
      job.finishedAt = new Date().toISOString();
    } catch (err) {
      job.phase = "error";
      job.error = err instanceof Error ? err.message : String(err);
      job.message = job.error;
      job.finishedAt = new Date().toISOString();
    }
    jobsById.set(appId, { ...job });
    lastJob = { ...job };
  })();

  return getAppUpdateJob(appId);
}
