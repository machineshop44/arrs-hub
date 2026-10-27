/**
 * Click-to-update jobs for *arr apps (ApplicationUpdate), Tautulli (cmd=update),
 * and Companion-side qBit/SAB (winget via Companion).
 */
import { ARR_API_APP_IDS, getArrApiKey } from "./arr-api-keys.mjs";
import { createServiceUrlResolver } from "./url-policy.mjs";
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

function resolveArrBaseUrl(appId, resolver) {
  return normalizeBase(resolver.resolve(appId, { fallbackKey: "baseUrl" }));
}

function resolveTautulliBaseUrl(resolver) {
  const url = normalizeBase(
    resolver.resolve("tautulli", { fallbackKey: "baseUrl" }),
  );
  return url ? normalizeTautulliBaseUrl(url) : "";
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

function arrHeaders(apiKey) {
  return {
    "X-Api-Key": apiKey,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRestartDisconnect(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return /fetch failed|ECONNREFUSED|ECONNRESET|socket|aborted|timeout|HTTP 502|HTTP 503|HTTP 504/i.test(
    msg,
  );
}

/**
 * Decide whether *arr can be updated from the Hub.
 * Exported for tests.
 * @param {{ updateMechanism?: string } | null} host
 * @param {object[]} updates
 */
export function planArrUpdate(host, updates) {
  const mechanism = String(host?.updateMechanism || "BuiltIn");
  // Docker / NAS packages cannot be updated by ApplicationUpdate.
  if (/^(docker|external|apt)$/i.test(mechanism)) {
    return {
      ok: false,
      message: `uses update mechanism "${mechanism}" — update that host manually, not from the Hub`,
    };
  }
  const list = Array.isArray(updates) ? updates : [];
  const installable =
    list.find((u) => u?.installable && !u?.installed) ||
    list.find((u) => u?.latest && u?.installable);
  if (installable) {
    return {
      ok: true,
      version: String(installable.version || "").trim() || null,
      mechanism,
    };
  }
  const latest = list.find((u) => u?.latest);
  if (latest?.installed) {
    return {
      ok: true,
      alreadyCurrent: true,
      version: String(latest.version || "").trim() || null,
      mechanism,
    };
  }
  return {
    ok: false,
    message:
      "has no installable update via its built-in updater (open System → Updates in the app)",
  };
}

/**
 * Tautulli update_check payload → whether cmd=update should run.
 * Exported for tests.
 */
export function planTautulliUpdate(checkResponse) {
  const resp = checkResponse?.response || checkResponse || {};
  const result = String(resp?.result || "").toLowerCase();
  const data = resp?.data && typeof resp.data === "object" ? resp.data : {};
  const updateFlag =
    resp?.update === true ||
    resp?.update === 1 ||
    resp?.update === "true" ||
    data.update === true ||
    data.update === 1 ||
    data.update === "true";
  const latest =
    String(
      resp?.latest_release ||
        resp?.latest_version ||
        data.latest_release ||
        data.latest_version ||
        "",
    )
      .replace(/^v/i, "")
      .trim() || null;

  if (result === "error") {
    return {
      ok: false,
      message: resp?.message || data?.message || "Tautulli update_check failed",
    };
  }
  if (!updateFlag) {
    return { ok: true, alreadyCurrent: true, latest };
  }
  return { ok: true, alreadyCurrent: false, latest };
}

async function runArrApplicationUpdate(appId, baseUrl, apiKey) {
  const label = LABELS[appId] || appId;
  const base = normalizeBase(baseUrl);
  if (!base) throw new Error(`No URL configured for ${label}.`);
  if (!apiKey) {
    throw new Error(
      `No API key saved for ${label}. Add it in Settings → Apps & monitoring.`,
    );
  }
  const apiVer = arrApiVersion(appId);
  const headers = arrHeaders(apiKey);

  let host = null;
  try {
    host = await fetchJson(`${base}/api/${apiVer}/config/host`, { headers }, 15000);
  } catch {
    host = null;
  }

  let updates = [];
  try {
    const raw = await fetchJson(`${base}/api/${apiVer}/update`, { headers }, 20000);
    updates = Array.isArray(raw) ? raw : [];
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${label} could not list updates (${detail}). Check the URL/API key.`,
    );
  }

  const plan = planArrUpdate(host, updates);
  if (!plan.ok) throw new Error(`${label} ${plan.message}.`);
  if (plan.alreadyCurrent) {
    return `${label} is already on the latest version${plan.version ? ` (${plan.version})` : ""}.`;
  }

  let command;
  try {
    command = await fetchJson(
      `${base}/api/${apiVer}/command`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "ApplicationUpdate" }),
      },
      30000,
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${label} refused ApplicationUpdate (${detail}). Check the API key and that BuiltIn updates are enabled.`,
    );
  }

  const commandId = Number(command?.id);
  const target = plan.version ? ` ${plan.version}` : "";
  if (!Number.isFinite(commandId) || commandId <= 0) {
    return `${label} update to${target} accepted — the app will download and restart itself.`;
  }

  for (let i = 0; i < 45; i++) {
    await sleep(2000);
    try {
      const status = await fetchJson(
        `${base}/api/${apiVer}/command/${commandId}`,
        { headers: { "X-Api-Key": apiKey, Accept: "application/json" } },
        10000,
      );
      const state = String(status?.status || "").toLowerCase();
      if (state === "completed") {
        return `${label} updated to${target} and finished its update command.`;
      }
      if (state === "failed") {
        throw new Error(
          status?.message || status?.result || `${label} update command failed.`,
        );
      }
    } catch (err) {
      // App often kills its HTTP server while restarting into the new build.
      if (isRestartDisconnect(err)) {
        return `${label} stopped responding while updating to${target} — that usually means the restart worked. Refresh versions in a minute.`;
      }
      throw err;
    }
  }
  return `${label} update to${target} is still running — it may finish after a restart.`;
}

async function runTautulliUpdate(baseUrl) {
  const settings = loadTautulliSettings();
  const base = baseUrl ? normalizeTautulliBaseUrl(baseUrl) : "";
  const apiKey = String(settings.apiKey || "").trim();
  if (!base) throw new Error("No Tautulli URL configured.");
  if (!apiKey) {
    throw new Error(
      "No Tautulli API key saved. Add it in Settings → Apps & monitoring.",
    );
  }
  const api = (cmd, timeoutMs = 30000) =>
    fetchJson(
      `${base}/api/v2?apikey=${encodeURIComponent(apiKey)}&cmd=${encodeURIComponent(cmd)}`,
      {},
      timeoutMs,
    );

  let check;
  try {
    check = await api("update_check", 20000);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Tautulli update_check failed (${detail}).`);
  }
  const plan = planTautulliUpdate(check);
  if (!plan.ok) throw new Error(plan.message);
  if (plan.alreadyCurrent) {
    return `Tautulli is already up to date${plan.latest ? ` (${plan.latest})` : ""}.`;
  }

  try {
    const data = await api("update", 120000);
    const resp = data?.response || data || {};
    if (String(resp.result || "").toLowerCase() === "error") {
      throw new Error(resp.message || "Tautulli update failed.");
    }
    return (
      resp.message ||
      `Tautulli update${plan.latest ? ` to ${plan.latest}` : ""} started — it may restart shortly.`
    );
  } catch (err) {
    if (isRestartDisconnect(err)) {
      return `Tautulli stopped responding while updating${plan.latest ? ` to ${plan.latest}` : ""} — that usually means the restart worked.`;
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
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
    throw new Error(
      started.message ||
        `Companion on ${pc.name || "the downloader PC"} refused the update. Is Companion running and paired?`,
    );
  }

  let statusFailures = 0;
  for (let i = 0; i < 150; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const status = await requestCompanionAppUpdateStatus(url, key, appId);
    if (!status.ok) {
      statusFailures += 1;
      if (statusFailures >= 5) {
        throw new Error(
          status.message ||
            `Lost contact with Companion on ${pc.name || "the downloader PC"} while updating.`,
        );
      }
      continue;
    }
    statusFailures = 0;
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
    `${LABELS[appId] || appId} update is still running on Companion — check that PC (winget may be waiting for a UAC prompt).`,
  );
}

/**
 * @param {{ id: string, urls?: Record<string, string>, baseUrl?: string, pcId?: string }} body
 * @param {{ requestHost?: string }} [ctx]
 */
export function startAppUpdate(body = {}, ctx = {}) {
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
  const resolver = createServiceUrlResolver({
    urls,
    requestHost: ctx.requestHost,
  });
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
        message = await runTautulliUpdate(resolveTautulliBaseUrl(resolver));
      } else {
        message = await runArrApplicationUpdate(
          appId,
          resolveArrBaseUrl(appId, resolver),
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
