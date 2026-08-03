import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR, ensureDataDirs } from "./config.mjs";

export const WATCHDOG_SETTINGS_PATH = path.join(DATA_DIR, "watchdog-settings.json");

/** Common Windows service names when *arr apps are installed as services */
export const DEFAULT_WINDOWS_SERVICES = {
  sonarr: "Sonarr",
  radarr: "Radarr",
  lidarr: "Lidarr",
  readarr: "Readarr",
  prowlarr: "Prowlarr",
  bazarr: "Bazarr",
  qbittorrent: "qbittorrent",
  sabnzbd: "SABnzbd",
  tautulli: "Tautulli",
  ombi: "Ombi",
  overseerr: "",
  fileflows: "",
  plex: "PlexUpdateService",
  calibre: "",
  whisparr: "Whisparr",
  ytarr: "",
  flaresolverr: "",
  "trash-guides": "",
};

function userProfileDir() {
  return process.env.USERPROFILE || os.homedir();
}

function localAppDataDir() {
  return (
    process.env.LOCALAPPDATA ||
    path.join(userProfileDir(), "AppData", "Local")
  );
}

/**
 * Common Windows install paths for exe-restart fallback.
 * *arr service installs → ProgramData (no username).
 * Per-user apps → resolved from USERPROFILE / LOCALAPPDATA.
 * Intentionally empty for non-standard installs (plex, qbit, sab, ombi, etc.).
 * @returns {Record<string, string>}
 */
export function getDefaultExePaths() {
  const localAppData = localAppDataDir();
  return {
    sonarr: "C:\\ProgramData\\Sonarr\\bin\\Sonarr.exe",
    radarr: "C:\\ProgramData\\Radarr\\bin\\Radarr.exe",
    lidarr: "C:\\ProgramData\\Lidarr\\bin\\Lidarr.exe",
    readarr: "C:\\ProgramData\\Readarr\\bin\\Readarr.exe",
    prowlarr: "C:\\ProgramData\\Prowlarr\\bin\\Prowlarr.exe",
    whisparr: "C:\\ProgramData\\Whisparr\\bin\\Whisparr.exe",
    bazarr: "C:\\Program Files\\Bazarr\\bazarr.exe",
    // Common portable / user install under Local AppData
    tautulli: path.join(localAppData, "Tautulli", "Tautulli.exe"),
    // Intentionally empty — leave for user:
    // plex, qbittorrent, sabnzbd, ombi, flaresolverr, ytarr, overseerr,
    // fileflows, calibre, trash-guides
  };
}

/** @deprecated use getDefaultExePaths() — kept for callers that expect a map */
export const DEFAULT_EXE_PATHS = getDefaultExePaths();

/** @returns {{ monitor: boolean, autoRestart: boolean, windowsService: string, exePath: string, exeArgs: string, exeCwd: string }} */
function defaultServiceWatch(id, windowsService) {
  const defaults = getDefaultExePaths();
  return {
    monitor:
      Boolean(windowsService) ||
      ["sonarr", "radarr", "prowlarr", "flaresolverr", "ytarr"].includes(id),
    autoRestart: Boolean(windowsService),
    windowsService,
    exePath: defaults[id] ?? "",
    exeArgs: "",
    exeCwd: "",
  };
}

export function defaultWatchdogSettings() {
  return {
    enabled: true,
    intervalSeconds: 30,
    failThreshold: 2,
    restartCooldownSeconds: 120,
    autoRestart: true,
    discordWebhookUrl: "",
    discordNotifyDown: true,
    discordNotifyRestart: true,
    discordNotifyRecovered: true,
    /** Wake-on-LAN for whole PCs (LAN only) */
    wolEnabled: true,
    wolCooldownSeconds: 300,
    /** @type {{ id: string, name: string, host: string, mac: string, monitor: boolean, wakeOnLan: boolean }[]} */
    pcs: [],
    /** @type {Record<string, { monitor: boolean, autoRestart: boolean, windowsService: string, exePath: string, exeArgs: string, exeCwd: string }>} */
    services: Object.fromEntries(
      Object.entries(DEFAULT_WINDOWS_SERVICES).map(([id, windowsService]) => [
        id,
        defaultServiceWatch(id, windowsService),
      ]),
    ),
  };
}

/**
 * Merge saved watchdog settings with defaults.
 * Never overwrite a non-empty saved exePath — defaults apply only when
 * missing/blank (new install or never configured for that service).
 */
export function loadWatchdogSettings() {
  ensureDataDirs();
  if (!fs.existsSync(WATCHDOG_SETTINGS_PATH)) {
    const defaults = defaultWatchdogSettings();
    saveWatchdogSettings(defaults);
    return defaults;
  }
  const raw = JSON.parse(fs.readFileSync(WATCHDOG_SETTINGS_PATH, "utf8"));
  const defaults = defaultWatchdogSettings();
  const defaultExe = getDefaultExePaths();
  const mergedServices = { ...defaults.services };

  for (const [id, cfg] of Object.entries(raw.services ?? {})) {
    const base = mergedServices[id] ?? defaultServiceWatch(id, "");
    const savedExe =
      typeof cfg.exePath === "string" ? cfg.exePath.trim() : "";
    // Critical: keep any user-saved path forever; fill defaults only when empty
    const exePath = savedExe || defaultExe[id] || "";
    mergedServices[id] = {
      ...base,
      ...cfg,
      exePath,
      exeArgs: typeof cfg.exeArgs === "string" ? cfg.exeArgs : "",
      exeCwd: typeof cfg.exeCwd === "string" ? cfg.exeCwd : "",
    };
  }

  return {
    ...defaults,
    ...raw,
    services: mergedServices,
    pcs: Array.isArray(raw.pcs) ? raw.pcs : defaults.pcs,
  };
}

export function saveWatchdogSettings(settings) {
  ensureDataDirs();
  fs.writeFileSync(WATCHDOG_SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf8");
}
