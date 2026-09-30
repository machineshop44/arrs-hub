import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR, ensureDataDirs } from "./config.mjs";

const DOWNLOAD_CLIENT_EXE_PATHS = {
  qbittorrent: "C:\\Program Files\\qBittorrent\\qbittorrent.exe",
  sabnzbd: "C:\\Program Files\\SABnzbd\\SABnzbd.exe",
};

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
  fileflows: "FileFlows",
  "fileflows-node": "FileFlows Node",
  surfshark: "",
  drivepool: "DrivePoolService",
  "stablebit-scanner": "Scanner",
  plex: "",
  calibre: "",
  whisparr: "Whisparr",
  ytarr: "",
  flaresolverr: "",
  "trash-guides": "",
};

/**
 * Process names as shown in Task Manager → Details (without ".exe").
 * Used to confirm an app is really running and to force-close a hung one
 * before restarting. Newer *arr builds run as "<App>.Console.exe".
 */
export const DEFAULT_PROCESS_NAMES = {
  sonarr: ["Sonarr.Console", "Sonarr"],
  radarr: ["Radarr.Console", "Radarr"],
  lidarr: ["Lidarr.Console", "Lidarr"],
  readarr: ["Readarr.Console", "Readarr"],
  prowlarr: ["Prowlarr.Console", "Prowlarr"],
  whisparr: ["Whisparr.Console", "Whisparr"],
  tautulli: ["Tautulli"],
  ombi: ["Ombi"],
  plex: ["Plex Media Server"],
  flaresolverr: ["flaresolverr"],
  qbittorrent: ["qbittorrent"],
  sabnzbd: ["SABnzbd"],
  surfshark: ["Surfshark"],
  drivepool: ["DrivePool.Service.Native", "DrivePool.Service"],
  "stablebit-scanner": ["Scanner.Service.Native", "Scanner.Service"],
  ytarr: ["ytarr"],
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
    // ytarr Inno Setup default: {localappdata}\Programs\ytarr\ytarr.exe
    ytarr: path.join(localAppData, "Programs", "ytarr", "ytarr.exe"),
    qbittorrent: DOWNLOAD_CLIENT_EXE_PATHS.qbittorrent,
    sabnzbd: DOWNLOAD_CLIENT_EXE_PATHS.sabnzbd,
    fileflows: path.join(
      process.env.APPDATA || path.join(userProfileDir(), "AppData", "Roaming"),
      "FileFlows",
      "Server",
    ),
    "fileflows-node": path.join(
      process.env.APPDATA || path.join(userProfileDir(), "AppData", "Roaming"),
      "FileFlows",
      "Node",
      "FileFlows.Node.exe",
    ),
    surfshark: path.join(
      process.env["ProgramFiles"] || "C:\\Program Files",
      "Surfshark",
      "Surfshark.exe",
    ),
    plex: path.join(
      process.env["ProgramFiles"] || "C:\\Program Files",
      "Plex",
      "Plex Media Server",
      "Plex Media Server.exe",
    ),
    // Intentionally empty — leave for user:
    // ombi, flaresolverr, overseerr, calibre, trash-guides
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
    restartPcId: "",
    processNames: DEFAULT_PROCESS_NAMES[id] ? [...DEFAULT_PROCESS_NAMES[id]] : [],
  };
}

export function defaultWatchdogSettings() {
  const settings = {
    enabled: true,
    intervalSeconds: 30,
    failThreshold: 2,
    /** After Hub start: probe for UI, but no Discord-down / auto-restart yet. */
    startupGraceSeconds: 120,
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
    companionUrlHints: {},
    /** Last Port Watch targets from the Hub UI (survive closed browser). */
    targets: [],
    /** @type {Record<string, { monitor: boolean, autoRestart: boolean, windowsService: string, exePath: string, exeArgs: string, exeCwd: string }>} */
    services: Object.fromEntries(
      Object.entries(DEFAULT_WINDOWS_SERVICES).map(([id, windowsService]) => [
        id,
        defaultServiceWatch(id, windowsService),
      ]),
    ),
  };
  return settings;
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
      processNames:
        Array.isArray(cfg.processNames) && cfg.processNames.length
          ? cfg.processNames.map(String)
          : base.processNames || [],
    };
    // Old default: restarting Plex *Update* Service never brought Plex Media Server back.
    if (id === "plex" && /^PlexUpdateService$/i.test(String(cfg.windowsService || ""))) {
      mergedServices[id].windowsService = "";
    }
  }

  return {
    ...defaults,
    ...raw,
    services: mergedServices,
    pcs: Array.isArray(raw.pcs) ? raw.pcs : defaults.pcs,
    companionUrlHints:
      raw.companionUrlHints && typeof raw.companionUrlHints === "object"
        ? raw.companionUrlHints
        : defaults.companionUrlHints,
    targets: Array.isArray(raw.targets) ? raw.targets : defaults.targets,
  };
}

export function saveWatchdogSettings(settings) {
  ensureDataDirs();
  fs.writeFileSync(WATCHDOG_SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf8");
}
