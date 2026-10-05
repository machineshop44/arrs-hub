import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, ensureDataDirs } from "./config.mjs";

export const MONITOR_SETTINGS_PATH = path.join(DATA_DIR, "monitor-settings.json");

export function defaultMonitorSettings() {
  return {
    /** Background problem scan (Discord alerts even with the dashboard closed). */
    problemsEnabled: true,
    problemsIntervalMinutes: 5,
    discordNotifyProblems: true,
    discordNotifyProblemsResolved: false,
    discordNotifyOmbiRequests: true,
    /** Warn when any *arr-reported drive drops below this many GB free. */
    diskFreeWarnGb: 50,
    /** Drives smaller than this are ignored (recovery / boot partitions). */
    diskMinTotalGb: 20,
    /** Only these drive letters are shown/alerted (N: is the StableBit DrivePool). Empty = all. */
    diskDrives: "C:, N:",
    /** Warn when qBittorrent is not bound to a network interface (VPN leak guard). */
    qbRequireInterfaceBind: true,
    /** Background scan fixes known stuck-queue cases (see queue-autofix.mjs). */
    autoFixEnabled: true,
    autoFixDangerous: true,
    autoFixSample: true,
    autoFixNotUpgrade: true,
    autoFixFailed: true,
    /** Accept Sonarr/Radarr manual imports when every file name matches the grabbed series/episodes or movie. */
    autoFixManualImport: true,
    /** Same episode/movie downloading twice → keep highest resolution, then custom format score. */
    autoFixDuplicates: true,
    /** Non-destructive health fixes: nudge imports, re-test clients/indexers/Prowlarr apps, cancel hung refreshes. */
    autoFixHealth: true,
    /** Private trackers with seed-time rules: remove from the *arr only, never from qBittorrent. */
    keepSeedingIndexers: "TorrentDay, TorrentLeech",
    /** Magnet stuck on metadata / torrent stalled with no connections → blocklist + search again. */
    autoFixStalled: true,
    stalledMetadataMinutes: 60,
    stalledNoConnectionsHours: 6,
    autoFixMaxPerScan: 10,
    discordNotifyAutoFix: true,
    /** "Indexer back in rotation" re-tests: Hub list only unless this is on. */
    discordNotifyIndexerFixes: false,
    /** A problem that clears and comes back is only announced again after this many hours. */
    problemReannounceHours: 6,
    /** Scheduled *arr config backups copied to backupDir. */
    backupEnabled: false,
    backupDir: "",
    backupIntervalHours: 168,
    backupKeep: 5,
    lastBackupAt: null,
    lastBackupResults: [],
  };
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalize(raw) {
  const d = defaultMonitorSettings();
  const s = { ...d, ...(raw && typeof raw === "object" ? raw : {}) };
  return {
    ...s,
    problemsEnabled: s.problemsEnabled !== false,
    problemsIntervalMinutes: clampNumber(s.problemsIntervalMinutes, d.problemsIntervalMinutes, 1, 120),
    discordNotifyProblems: s.discordNotifyProblems !== false,
    discordNotifyProblemsResolved: s.discordNotifyProblemsResolved === true,
    discordNotifyOmbiRequests: s.discordNotifyOmbiRequests !== false,
    diskFreeWarnGb: clampNumber(s.diskFreeWarnGb, d.diskFreeWarnGb, 0, 100000),
    diskMinTotalGb: clampNumber(s.diskMinTotalGb, d.diskMinTotalGb, 0, 100000),
    diskDrives:
      typeof s.diskDrives !== "string"
        ? d.diskDrives
        : s.diskDrives.trim() === "C:, D:"
          ? d.diskDrives
          : s.diskDrives.trim(),
    qbRequireInterfaceBind: s.qbRequireInterfaceBind !== false,
    autoFixEnabled: s.autoFixEnabled !== false,
    autoFixDangerous: s.autoFixDangerous !== false,
    autoFixSample: s.autoFixSample !== false,
    autoFixNotUpgrade: s.autoFixNotUpgrade !== false,
    autoFixFailed: s.autoFixFailed !== false,
    autoFixManualImport: s.autoFixManualImport !== false,
    autoFixHealth: s.autoFixHealth !== false,
    autoFixDuplicates: s.autoFixDuplicates !== false,
    keepSeedingIndexers:
      typeof s.keepSeedingIndexers === "string" ? s.keepSeedingIndexers.trim() : d.keepSeedingIndexers,
    autoFixStalled: s.autoFixStalled !== false,
    stalledMetadataMinutes: Math.round(clampNumber(s.stalledMetadataMinutes, d.stalledMetadataMinutes, 15, 24 * 60)),
    stalledNoConnectionsHours: clampNumber(s.stalledNoConnectionsHours, d.stalledNoConnectionsHours, 1, 24 * 14),
    autoFixMaxPerScan: Math.round(clampNumber(s.autoFixMaxPerScan, d.autoFixMaxPerScan, 1, 50)),
    discordNotifyAutoFix: s.discordNotifyAutoFix !== false,
    discordNotifyIndexerFixes: s.discordNotifyIndexerFixes === true,
    problemReannounceHours: clampNumber(s.problemReannounceHours, d.problemReannounceHours, 0, 168),
    backupEnabled: s.backupEnabled === true,
    backupDir: String(s.backupDir || "").trim(),
    backupIntervalHours: clampNumber(s.backupIntervalHours, d.backupIntervalHours, 1, 24 * 90),
    backupKeep: Math.round(clampNumber(s.backupKeep, d.backupKeep, 1, 100)),
    lastBackupResults: Array.isArray(s.lastBackupResults) ? s.lastBackupResults : [],
  };
}

export function loadMonitorSettings() {
  ensureDataDirs();
  if (!fs.existsSync(MONITOR_SETTINGS_PATH)) return defaultMonitorSettings();
  try {
    return normalize(JSON.parse(fs.readFileSync(MONITOR_SETTINGS_PATH, "utf8")));
  } catch {
    return defaultMonitorSettings();
  }
}

export function saveMonitorSettings(settings) {
  ensureDataDirs();
  const next = normalize(settings);
  fs.writeFileSync(MONITOR_SETTINGS_PATH, JSON.stringify(next, null, 2), "utf8");
  return next;
}

/** Merge a UI patch; status fields (lastBackup*) are server-owned. */
export function updateMonitorSettings(patch = {}) {
  const { lastBackupAt: _a, lastBackupResults: _b, ...rest } = patch || {};
  return saveMonitorSettings({ ...loadMonitorSettings(), ...rest });
}
