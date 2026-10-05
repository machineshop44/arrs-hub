import { useCallback, useEffect, useState } from "react";

type BackupResult = {
  id: string;
  ok: boolean;
  file?: string;
  bytes?: number;
  error?: string;
};

type MonitorSettings = {
  problemsEnabled: boolean;
  problemsIntervalMinutes: number;
  discordNotifyProblems: boolean;
  discordNotifyProblemsResolved: boolean;
  discordNotifyOmbiRequests: boolean;
  diskFreeWarnGb: number;
  diskDrives: string;
  qbRequireInterfaceBind: boolean;
  autoFixEnabled: boolean;
  autoFixDangerous: boolean;
  autoFixSample: boolean;
  autoFixNotUpgrade: boolean;
  autoFixFailed: boolean;
  autoFixManualImport: boolean;
  autoFixHealth: boolean;
  autoFixDuplicates: boolean;
  keepSeedingIndexers: string;
  autoFixStalled: boolean;
  stalledMetadataMinutes: number;
  stalledNoConnectionsHours: number;
  discordNotifyAutoFix: boolean;
  discordNotifyIndexerFixes: boolean;
  problemReannounceHours: number;
  backupEnabled: boolean;
  backupDir: string;
  backupIntervalHours: number;
  backupKeep: number;
  lastBackupAt: string | null;
  lastBackupResults: BackupResult[];
};

interface MonitorSettingsSectionProps {
  serverUp: boolean | null;
}

export function MonitorSettingsSection({ serverUp }: MonitorSettingsSectionProps) {
  const [settings, setSettings] = useState<MonitorSettings | null>(null);
  const [backupDirResolved, setBackupDirResolved] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(async () => {
    if (serverUp === false) return;
    try {
      const res = await fetch("/api/monitor/settings");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not load alert settings");
      setSettings(json.settings as MonitorSettings);
      setBackupDirResolved(json.backupDirResolved || "");
    } catch (err) {
      setMessage({ type: "err", text: err instanceof Error ? err.message : String(err) });
    }
  }, [serverUp]);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = (next: Partial<MonitorSettings>) =>
    setSettings((prev) => (prev ? { ...prev, ...next } : prev));

  const save = async () => {
    if (!settings) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/monitor/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      setSettings(json.settings as MonitorSettings);
      setBackupDirResolved(json.backupDirResolved || "");
      setMessage({ type: "ok", text: "Alert & backup settings saved." });
    } catch (err) {
      setMessage({ type: "err", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const post = async (url: string, okText: (json: Record<string, unknown>) => string) => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(url, { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Request failed");
      setMessage({ type: "ok", text: okText(json) });
      await load();
    } catch (err) {
      setMessage({ type: "err", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const disabled = serverUp === false || busy || !settings;

  return (
    <section className="settings-group" id="alerts-backups">
      <h3>Problem alerts &amp; backups</h3>
      <p className="settings-hint">
        The Hub checks your stack in the background (even with this window
        closed) and posts to the Discord webhook above: *arr health warnings
        (indexers down, missing root folders), low disk space, qBittorrent not
        bound to the VPN, stuck downloads, and new Ombi requests. Each problem
        is sent once, not every check.
      </p>
      {settings && (
        <>
          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.problemsEnabled}
              disabled={disabled}
              onChange={(e) => patch({ problemsEnabled: e.target.checked })}
            />
            <span className="toggle-label">Background problem scan</span>
          </label>
          <label className="field">
            <span>Scan every (minutes)</span>
            <input
              type="number"
              min={1}
              max={120}
              value={settings.problemsIntervalMinutes}
              disabled={disabled}
              onChange={(e) => patch({ problemsIntervalMinutes: Number(e.target.value) })}
            />
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.discordNotifyProblems}
              disabled={disabled}
              onChange={(e) => patch({ discordNotifyProblems: e.target.checked })}
            />
            <span className="toggle-label">Discord: new problems</span>
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.discordNotifyProblemsResolved}
              disabled={disabled}
              onChange={(e) => patch({ discordNotifyProblemsResolved: e.target.checked })}
            />
            <span className="toggle-label">Discord: problems resolved</span>
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.discordNotifyOmbiRequests}
              disabled={disabled}
              onChange={(e) => patch({ discordNotifyOmbiRequests: e.target.checked })}
            />
            <span className="toggle-label">Discord: new Ombi requests</span>
          </label>
          <label className="field">
            <span>Low disk alert below (GB free)</span>
            <input
              type="number"
              min={0}
              value={settings.diskFreeWarnGb}
              disabled={disabled}
              onChange={(e) => patch({ diskFreeWarnGb: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            <span>Drives to watch (blank = all)</span>
            <input
              type="text"
              placeholder="C:, N:"
              value={settings.diskDrives}
              disabled={disabled}
              onChange={(e) => patch({ diskDrives: e.target.value })}
            />
          </label>
          <p className="settings-hint">
            N: is the StableBit DrivePool, so its free space already covers the
            pooled disks — listing them separately is redundant.
          </p>
          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.qbRequireInterfaceBind}
              disabled={disabled}
              onChange={(e) => patch({ qbRequireInterfaceBind: e.target.checked })}
            />
            <span className="toggle-label">
              Warn if qBittorrent is not bound to the VPN adapter
            </span>
          </label>

          <h4 className="settings-subhead">Auto-fix stuck downloads</h4>
          <p className="settings-hint">
            Each background scan clears known-bad queue items in Sonarr, Radarr,
            Lidarr, Readarr and Whisparr. Manual imports are only accepted when
            every file name matches what was grabbed; anything else is left for
            you.
          </p>
          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.autoFixEnabled}
              disabled={disabled}
              onChange={(e) => patch({ autoFixEnabled: e.target.checked })}
            />
            <span className="toggle-label">Auto-fix enabled</span>
          </label>
          {(
            [
              ["autoFixDangerous", "Unwanted files (.exe, .lnk, .scr…) → blocklist + search again"],
              ["autoFixSample", "Sample only / no importable files → blocklist + search again"],
              ["autoFixNotUpgrade", "Not an upgrade / already imported → remove"],
              ["autoFixFailed", "Failed download → blocklist + search again"],
              [
                "autoFixManualImport",
                "Manual import (Sonarr/Radarr) → import when the file name matches the series + SxxEyy / movie + year (also approves \"TBA title\" blocks)",
              ],
              [
                "autoFixDuplicates",
                "Same episode / movie downloading twice → keep a healthy copy over a stalled one, then highest resolution, then custom format score; remove the rest (season packs kept)",
              ],
              [
                "autoFixStalled",
                "Stuck torrents → blocklist + search again: magnet stuck on \"downloading metadata\" or torrent \"stalled with no connections\" past the waits below",
              ],
              [
                "autoFixHealth",
                "Health nudges (never delete): re-run pending imports, re-test download clients / failed indexers / Prowlarr app links, cancel refreshes hung 3h+",
              ],
            ] as const
          ).map(([key, label]) => (
            <label className="toggle" key={key}>
              <input
                type="checkbox"
                checked={settings[key]}
                disabled={disabled || !settings.autoFixEnabled}
                onChange={(e) => patch({ [key]: e.target.checked })}
              />
              <span className="toggle-label">{label}</span>
            </label>
          ))}
          <label className="field">
            <span>Keep seeding (remove from the *arr only, never from qBittorrent)</span>
            <input
              type="text"
              placeholder="TorrentDay, TorrentLeech"
              value={settings.keepSeedingIndexers}
              disabled={disabled}
              onChange={(e) => patch({ keepSeedingIndexers: e.target.value })}
            />
          </label>
          <p className="settings-hint">
            Indexer names, comma-separated. Also applies to the dashboard
            Remove / Blocklist buttons. Torrents with no indexer name are kept
            seeding to be safe.
          </p>
          <label className="field">
            <span>Stuck on metadata — wait (minutes)</span>
            <input
              type="number"
              min={15}
              value={settings.stalledMetadataMinutes}
              disabled={disabled}
              onChange={(e) => patch({ stalledMetadataMinutes: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            <span>Stalled with no connections — wait (hours)</span>
            <input
              type="number"
              min={1}
              value={settings.stalledNoConnectionsHours}
              disabled={disabled}
              onChange={(e) => patch({ stalledNoConnectionsHours: Number(e.target.value) })}
            />
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.discordNotifyAutoFix}
              disabled={disabled}
              onChange={(e) => patch({ discordNotifyAutoFix: e.target.checked })}
            />
            <span className="toggle-label">Discord: auto-fixes</span>
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.discordNotifyIndexerFixes}
              disabled={disabled}
              onChange={(e) => patch({ discordNotifyIndexerFixes: e.target.checked })}
            />
            <span className="toggle-label">
              Discord: &quot;indexer back in rotation&quot; re-tests (off = Hub list only)
            </span>
          </label>
          <label className="field">
            <span>Re-announce a problem that clears and comes back after (hours)</span>
            <input
              type="number"
              min={0}
              value={settings.problemReannounceHours}
              disabled={disabled}
              onChange={(e) => patch({ problemReannounceHours: Number(e.target.value) })}
            />
          </label>
          <p className="settings-hint">
            Stops flapping alerts (e.g. a public tracker going up and down). A
            failing indexer is one problem no matter how many *arr apps report it.
          </p>

          <h4 className="settings-subhead">Scheduled *arr config backups</h4>
          <p className="settings-hint">
            Runs each app&apos;s built-in Backup (Sonarr, Radarr, Lidarr,
            Prowlarr, …) and copies the zip here. Point it at a Google Drive
            folder for off-PC copies.
          </p>
          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.backupEnabled}
              disabled={disabled}
              onChange={(e) => patch({ backupEnabled: e.target.checked })}
            />
            <span className="toggle-label">Back up automatically</span>
          </label>
          <label className="field">
            <span>Backup folder</span>
            <input
              type="text"
              value={settings.backupDir}
              placeholder={backupDirResolved || "G:\\My Drive\\Arrs-Hub Backups"}
              disabled={disabled}
              onChange={(e) => patch({ backupDir: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Every (hours)</span>
            <input
              type="number"
              min={1}
              value={settings.backupIntervalHours}
              disabled={disabled}
              onChange={(e) => patch({ backupIntervalHours: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            <span>Keep per app</span>
            <input
              type="number"
              min={1}
              max={100}
              value={settings.backupKeep}
              disabled={disabled}
              onChange={(e) => patch({ backupKeep: Number(e.target.value) })}
            />
          </label>
          {settings.lastBackupAt && (
            <p className="settings-hint">
              Last backup {new Date(settings.lastBackupAt).toLocaleString()}:{" "}
              {settings.lastBackupResults.length === 0
                ? "no *arr apps configured"
                : settings.lastBackupResults
                    .map((r) => `${r.id} ${r.ok ? "✓" : `✗ (${r.error})`}`)
                    .join(" · ")}
            </p>
          )}
        </>
      )}
      {message && (
        <div className={`sync-alert ${message.type === "ok" ? "sync-alert-ok" : "sync-alert-err"}`}>
          {message.text}
        </div>
      )}
      <div className="watchdog-bar-actions">
        <button type="button" className="btn btn-secondary" disabled={disabled} onClick={() => void save()}>
          {busy ? "Working…" : "Save alert & backup settings"}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={disabled}
          onClick={() =>
            void post("/api/monitor/scan-now", (json) => {
              const snap = json.snapshot as { problems?: unknown[] } | null;
              return `Scan done — ${snap?.problems?.length ?? 0} active item(s). New ones were sent to Discord.`;
            })
          }
        >
          Scan now
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={disabled}
          onClick={() =>
            void post("/api/monitor/backup-now", (json) => {
              const results = (json.results as BackupResult[]) || [];
              const ok = results.filter((r) => r.ok).length;
              return `Backed up ${ok}/${results.length} app(s) to ${String(json.dir || "")}.`;
            })
          }
        >
          Back up now
        </button>
      </div>
    </section>
  );
}
