import fs from "node:fs";
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
  "trash-guides": "",
};

export function defaultWatchdogSettings() {
  return {
    enabled: true,
    intervalSeconds: 30,
    failThreshold: 2,
    restartCooldownSeconds: 120,
    autoRestart: true,
    /** @type {Record<string, { monitor: boolean, autoRestart: boolean, windowsService: string }>} */
    services: Object.fromEntries(
      Object.entries(DEFAULT_WINDOWS_SERVICES).map(([id, windowsService]) => [
        id,
        {
          monitor: Boolean(windowsService) || ["sonarr", "radarr", "prowlarr"].includes(id),
          autoRestart: Boolean(windowsService),
          windowsService,
        },
      ]),
    ),
  };
}

export function loadWatchdogSettings() {
  ensureDataDirs();
  if (!fs.existsSync(WATCHDOG_SETTINGS_PATH)) {
    const defaults = defaultWatchdogSettings();
    saveWatchdogSettings(defaults);
    return defaults;
  }
  const raw = JSON.parse(fs.readFileSync(WATCHDOG_SETTINGS_PATH, "utf8"));
  const defaults = defaultWatchdogSettings();
  return {
    ...defaults,
    ...raw,
    services: { ...defaults.services, ...(raw.services ?? {}) },
  };
}

export function saveWatchdogSettings(settings) {
  ensureDataDirs();
  fs.writeFileSync(WATCHDOG_SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf8");
}
