import { loadSyncSettings, saveSyncSettings } from "./config.mjs";
import {
  loadIntegrationsSettings,
  saveIntegrationsSettings,
} from "./integrations.mjs";

export const ARR_API_APP_IDS = [
  "sonarr",
  "radarr",
  "lidarr",
  "readarr",
  "prowlarr",
  "bazarr",
  "whisparr",
];

function pickSecret(incoming, current) {
  if (typeof incoming !== "string") return current;
  const trimmed = incoming.trim();
  if (!trimmed) return current;
  if (trimmed.includes("…") || trimmed.includes("•")) return current;
  return trimmed;
}

function maskKey(key) {
  if (!key) return "";
  if (key.length <= 8) return "••••••••";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** @param {string} id */
export function getArrApiKey(id) {
  const appId = String(id || "").trim();
  if (!ARR_API_APP_IDS.includes(appId)) return "";
  if (appId === "sonarr" || appId === "radarr") {
    const sync = loadSyncSettings();
    return String(sync[appId]?.apiKey || "").trim();
  }
  const integrations = loadIntegrationsSettings();
  return String(integrations.arr?.[appId]?.apiKey || "").trim();
}

export function publicArrCredentials() {
  const sync = loadSyncSettings();
  const integrations = loadIntegrationsSettings();
  /** @type {Record<string, { apiKeySet: boolean }>} */
  const out = {};
  for (const id of ARR_API_APP_IDS) {
    let key = "";
    if (id === "sonarr") key = sync.sonarr?.apiKey || "";
    else if (id === "radarr") key = sync.radarr?.apiKey || "";
    else key = integrations.arr?.[id]?.apiKey || "";
    out[id] = { apiKeySet: Boolean(String(key).trim()) };
  }
  return out;
}

/**
 * @param {Record<string, string|undefined>} patch App id → api key (blank keeps saved)
 */
export function updateArrCredentials(patch = {}) {
  const sync = loadSyncSettings();
  let syncDirty = false;
  if (patch.sonarr !== undefined) {
    const next = pickSecret(patch.sonarr, sync.sonarr.apiKey);
    if (next !== sync.sonarr.apiKey) {
      sync.sonarr.apiKey = next;
      syncDirty = true;
    }
  }
  if (patch.radarr !== undefined) {
    const next = pickSecret(patch.radarr, sync.radarr.apiKey);
    if (next !== sync.radarr.apiKey) {
      sync.radarr.apiKey = next;
      syncDirty = true;
    }
  }
  if (syncDirty) saveSyncSettings(sync);

  const integrations = loadIntegrationsSettings();
  const arr = { ...(integrations.arr || {}) };
  let arrDirty = false;
  for (const id of ARR_API_APP_IDS) {
    if (id === "sonarr" || id === "radarr") continue;
    if (patch[id] === undefined) continue;
    const prev = arr[id]?.apiKey || "";
    const next = pickSecret(patch[id], prev);
    if (next !== prev) {
      arr[id] = { ...(arr[id] || {}), apiKey: next };
      arrDirty = true;
    }
  }
  if (arrDirty) {
    saveIntegrationsSettings({ ...integrations, arr });
  }
  return publicArrCredentials();
}

export function maskedArrCredentialsForDisplay() {
  const sync = loadSyncSettings();
  const integrations = loadIntegrationsSettings();
  /** @type {Record<string, { apiKey: string, apiKeySet: boolean }>} */
  const out = {};
  for (const id of ARR_API_APP_IDS) {
    let key = "";
    if (id === "sonarr") key = sync.sonarr?.apiKey || "";
    else if (id === "radarr") key = sync.radarr?.apiKey || "";
    else key = integrations.arr?.[id]?.apiKey || "";
    out[id] = {
      apiKey: key ? maskKey(key) : "",
      apiKeySet: Boolean(String(key).trim()),
    };
  }
  return out;
}
