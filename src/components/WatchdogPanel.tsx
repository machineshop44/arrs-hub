import { useCallback, useEffect, useState } from "react";

export type ServiceWatchConfig = {
  monitor: boolean;
  autoRestart: boolean;
  windowsService: string;
  exePath: string;
};

export type PcWatchConfig = {
  id: string;
  name: string;
  host: string;
  mac: string;
  monitor: boolean;
  wakeOnLan: boolean;
};

export type PcLiveStatus = {
  online: boolean | null;
  lastChecked?: string | null;
  consecutiveFails?: number;
  lastWakeAt?: string | null;
  lastWakeResult?: string | null;
  message?: string;
  method?: string | null;
};

export type WatchdogSettings = {
  enabled: boolean;
  intervalSeconds: number;
  failThreshold: number;
  restartCooldownSeconds: number;
  autoRestart: boolean;
  wolEnabled: boolean;
  wolCooldownSeconds: number;
  discordWebhookSet?: boolean;
  services: Record<string, ServiceWatchConfig>;
  pcs: PcWatchConfig[];
};

interface WatchdogPanelProps {
  onClose: () => void;
  serviceNames: { id: string; name: string; enabled: boolean }[];
}

function newPcId() {
  return `pc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function emptyPc(): PcWatchConfig {
  return {
    id: newPcId(),
    name: "",
    host: "",
    mac: "",
    monitor: true,
    wakeOnLan: true,
  };
}

export function WatchdogPanel({ onClose, serviceNames }: WatchdogPanelProps) {
  const [settings, setSettings] = useState<WatchdogSettings | null>(null);
  const [pcStatus, setPcStatus] = useState<Record<string, PcLiveStatus>>({});
  const [busy, setBusy] = useState(false);
  const [wakingId, setWakingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [serverUp, setServerUp] = useState<boolean | null>(null);

  const applyStatus = (json: {
    settings?: WatchdogSettings;
    pcs?: Record<string, PcLiveStatus>;
  }) => {
    if (json.settings) {
      setSettings({
        ...json.settings,
        wolEnabled: json.settings.wolEnabled !== false,
        wolCooldownSeconds: json.settings.wolCooldownSeconds || 300,
        pcs: Array.isArray(json.settings.pcs) ? json.settings.pcs : [],
      });
    }
    setPcStatus(json.pcs ?? {});
  };

  const load = useCallback(async () => {
    try {
      const health = await fetch("/api/health");
      setServerUp(health.ok);
      if (!health.ok) return;
      const res = await fetch("/api/watchdog/status");
      const json = await res.json();
      applyStatus(json);
    } catch {
      setServerUp(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!settings) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/watchdog/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: settings.enabled,
          intervalSeconds: settings.intervalSeconds,
          failThreshold: settings.failThreshold,
          restartCooldownSeconds: settings.restartCooldownSeconds,
          autoRestart: settings.autoRestart,
          wolEnabled: settings.wolEnabled,
          wolCooldownSeconds: settings.wolCooldownSeconds,
          services: settings.services,
          pcs: settings.pcs,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      applyStatus(json);
      // Reload so live PC map matches saved list after PUT
      await load();
      setMessage("Watchdog settings saved.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const wakeNow = async (pcId: string) => {
    setWakingId(pcId);
    setMessage(null);
    try {
      const res = await fetch("/api/watchdog/wol", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pcId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Wake failed");
      applyStatus(json);
      setMessage(json.message || `Wake packet sent for ${json.pc || "PC"}.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setWakingId(null);
    }
  };

  const updateService = (
    id: string,
    patch: Partial<ServiceWatchConfig>,
  ) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const current = prev.services[id] ?? {
        monitor: true,
        autoRestart: false,
        windowsService: "",
        exePath: "",
      };
      return {
        ...prev,
        services: {
          ...prev.services,
          [id]: { ...current, ...patch },
        },
      };
    });
  };

  const updatePc = (id: string, patch: Partial<PcWatchConfig>) => {
    setSettings((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        pcs: prev.pcs.map((pc) => (pc.id === id ? { ...pc, ...patch } : pc)),
      };
    });
  };

  const removePc = (id: string) => {
    setSettings((prev) => {
      if (!prev) return prev;
      return { ...prev, pcs: prev.pcs.filter((pc) => pc.id !== id) };
    });
  };

  const addPc = () => {
    setSettings((prev) => {
      if (!prev) return prev;
      return { ...prev, pcs: [...prev.pcs, emptyPc()] };
    });
  };

  const apps = serviceNames.filter(
    (service) => service.enabled && service.id !== "trash-guides",
  );

  const onlineLabel = (status: PcLiveStatus | undefined) => {
    if (!status || status.online === null || status.online === undefined) {
      return { text: "Unknown", className: "pc-status pc-status-unknown" };
    }
    if (status.online) {
      return { text: "Online", className: "pc-status pc-status-online" };
    }
    return { text: "Offline", className: "pc-status pc-status-offline" };
  };

  return (
    <div className="settings-overlay" onClick={onClose} role="presentation">
      <div
        className="settings-panel sync-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="watchdog-title"
        aria-modal="true"
      >
        <header className="settings-header">
          <h2 id="watchdog-title">Port watch &amp; restart</h2>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="settings-body">
          {serverUp === false && (
            <div className="sync-alert sync-alert-err">
              Sync/watch server offline. Run <code>npm run dev</code> or{" "}
              <code>start-hub.bat</code> on this Plex PC.
            </div>
          )}

          {serverUp && settings && (
            <>
              <section className="settings-group">
                <h3>Plex PC watchdog</h3>
                <p className="settings-hint">
                  Keep Arr&apos;s Hub running on this PC. Status uses your
                  current link mode: <strong>Home</strong> ports when Home/Auto
                  says you&apos;re home (restart allowed),{" "}
                  <strong>Remote</strong> URLs when you&apos;re away (status
                  only — no remote restart). Prefer a Windows service name when
                  the app is installed as a service; optionally set an{" "}
                  <strong>exe path</strong> as fallback if the service restart
                  fails or no service is configured. Discord webhook for
                  down/restart alerts is under hub <strong>Settings</strong>.
                  {settings.discordWebhookSet ? " (webhook saved)" : ""}
                </p>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={settings.enabled}
                    onChange={(e) =>
                      setSettings((prev) =>
                        prev ? { ...prev, enabled: e.target.checked } : prev,
                      )
                    }
                  />
                  <span className="toggle-label">Enable monitoring</span>
                </label>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={settings.autoRestart}
                    onChange={(e) =>
                      setSettings((prev) =>
                        prev ? { ...prev, autoRestart: e.target.checked } : prev,
                      )
                    }
                  />
                  <span className="toggle-label">
                    Allow auto-restart (global)
                  </span>
                </label>
                <label className="field">
                  <span>Check every (seconds)</span>
                  <input
                    type="number"
                    min={10}
                    max={600}
                    value={settings.intervalSeconds}
                    onChange={(e) =>
                      setSettings((prev) =>
                        prev
                          ? {
                              ...prev,
                              intervalSeconds: Number(e.target.value) || 30,
                            }
                          : prev,
                      )
                    }
                  />
                </label>
                <label className="field">
                  <span>Failed checks before restart</span>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={settings.failThreshold}
                    onChange={(e) =>
                      setSettings((prev) =>
                        prev
                          ? {
                              ...prev,
                              failThreshold: Number(e.target.value) || 2,
                            }
                          : prev,
                      )
                    }
                  />
                </label>
              </section>

              <section className="settings-group">
                <h3>Per app</h3>
                <p className="settings-hint">
                  Defaults use standard install paths (ProgramData for *arr;
                  user profile where relevant) and can be edited. Empty fields
                  only — your saved paths are never overwritten.
                </p>
                <div className="sync-presets">
                  {apps.map((app) => {
                    const cfg = settings.services[app.id] ?? {
                      monitor: true,
                      autoRestart: false,
                      windowsService: "",
                      exePath: "",
                    };
                    const exePlaceholder =
                      {
                        plex: "C:\\Program Files\\Plex\\Plex Media Server\\Plex Media Server.exe",
                        qbittorrent:
                          "C:\\Program Files\\qBittorrent\\qbittorrent.exe",
                        sabnzbd: "C:\\Program Files\\SABnzbd\\SABnzbd.exe",
                        ombi: "C:\\Program Files\\Ombi\\Ombi.exe",
                        flaresolverr:
                          "C:\\Program Files\\FlareSolverr\\FlareSolverr.exe",
                        ytarr: "C:\\Users\\…\\AppData\\Local\\Programs\\ytarr\\ytarr.exe",
                      }[app.id] ?? "C:\\ProgramData\\App\\bin\\App.exe";
                    return (
                      <div key={app.id} className="watchdog-service-row">
                        <strong>{app.name}</strong>
                        <label className="toggle">
                          <input
                            type="checkbox"
                            checked={cfg.monitor}
                            onChange={(e) =>
                              updateService(app.id, {
                                monitor: e.target.checked,
                              })
                            }
                          />
                          <span className="toggle-label">Monitor port</span>
                        </label>
                        <label className="toggle">
                          <input
                            type="checkbox"
                            checked={cfg.autoRestart}
                            onChange={(e) =>
                              updateService(app.id, {
                                autoRestart: e.target.checked,
                              })
                            }
                          />
                          <span className="toggle-label">Auto-restart</span>
                        </label>
                        <label className="field">
                          <span>Windows service name</span>
                          <input
                            type="text"
                            value={cfg.windowsService}
                            placeholder="e.g. Sonarr"
                            onChange={(e) =>
                              updateService(app.id, {
                                windowsService: e.target.value,
                              })
                            }
                          />
                        </label>
                        <label className="field">
                          <span>Exe path (fallback)</span>
                          <input
                            type="text"
                            value={cfg.exePath}
                            placeholder={exePlaceholder}
                            onChange={(e) =>
                              updateService(app.id, {
                                exePath: e.target.value,
                              })
                            }
                          />
                        </label>
                        <p className="settings-hint">
                          Restart tries the Windows service first. If that fails
                          or the service name is blank, Arrs Hub starts the exe
                          from its folder (Home / Plex PC only).
                        </p>
                      </div>
                    );
                  })}
                </div>
              </section>

              <section className="settings-group">
                <h3>PC power &amp; Wake-on-LAN</h3>
                <p className="settings-hint">
                  Monitor whole PCs by host/IP and optionally send a Wake-on-LAN
                  magic packet when they go offline.{" "}
                  <strong>WOL is LAN-only</strong> — it works after a power
                  outage when Arrs Hub runs on a machine that is still on the
                  same local network (or comes back with the network). It does{" "}
                  <strong>not</strong> work over the internet or remote links;
                  magic packets never leave your LAN.
                </p>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={settings.wolEnabled}
                    onChange={(e) =>
                      setSettings((prev) =>
                        prev
                          ? { ...prev, wolEnabled: e.target.checked }
                          : prev,
                      )
                    }
                  />
                  <span className="toggle-label">Enable Wake-on-LAN</span>
                </label>
                <label className="field">
                  <span>WOL cooldown (seconds)</span>
                  <input
                    type="number"
                    min={30}
                    max={3600}
                    value={settings.wolCooldownSeconds}
                    onChange={(e) =>
                      setSettings((prev) =>
                        prev
                          ? {
                              ...prev,
                              wolCooldownSeconds:
                                Number(e.target.value) || 300,
                            }
                          : prev,
                      )
                    }
                  />
                </label>
                <p className="settings-hint">
                  MAC tip: use the wired Ethernet adapter MAC (not Wi‑Fi) when
                  possible. In Windows:{" "}
                  <code>getmac /v</code> or Settings → Network → adapter
                  properties. BIOS/UEFI must have Wake-on-LAN enabled, and the
                  NIC should allow wake from magic packet.
                </p>

                <div className="sync-presets">
                  {settings.pcs.length === 0 && (
                    <p className="settings-hint">
                      No PCs yet. Add one with a local IP/hostname and MAC.
                    </p>
                  )}
                  {settings.pcs.map((pc) => {
                    const live = pcStatus[pc.id];
                    const status = onlineLabel(live);
                    return (
                      <div key={pc.id} className="watchdog-service-row watchdog-pc-row">
                        <div className="watchdog-pc-header">
                          <strong>{pc.name.trim() || "Unnamed PC"}</strong>
                          <span className={status.className}>{status.text}</span>
                        </div>
                        {live?.message && (
                          <p className="settings-hint watchdog-pc-message">
                            {live.message}
                            {live.lastWakeAt
                              ? ` · last wake ${new Date(live.lastWakeAt).toLocaleString()}`
                              : ""}
                          </p>
                        )}
                        <label className="field">
                          <span>Name</span>
                          <input
                            type="text"
                            value={pc.name}
                            placeholder="Living room PC"
                            onChange={(e) =>
                              updatePc(pc.id, { name: e.target.value })
                            }
                          />
                        </label>
                        <label className="field">
                          <span>Host / IP</span>
                          <input
                            type="text"
                            value={pc.host}
                            placeholder="192.168.1.50"
                            onChange={(e) =>
                              updatePc(pc.id, { host: e.target.value })
                            }
                          />
                        </label>
                        <label className="field">
                          <span>MAC address</span>
                          <input
                            type="text"
                            value={pc.mac}
                            placeholder="AA:BB:CC:DD:EE:FF"
                            onChange={(e) =>
                              updatePc(pc.id, { mac: e.target.value })
                            }
                          />
                        </label>
                        <label className="toggle">
                          <input
                            type="checkbox"
                            checked={pc.monitor}
                            onChange={(e) =>
                              updatePc(pc.id, { monitor: e.target.checked })
                            }
                          />
                          <span className="toggle-label">Monitor online</span>
                        </label>
                        <label className="toggle">
                          <input
                            type="checkbox"
                            checked={pc.wakeOnLan}
                            onChange={(e) =>
                              updatePc(pc.id, { wakeOnLan: e.target.checked })
                            }
                          />
                          <span className="toggle-label">Auto Wake-on-LAN</span>
                        </label>
                        <div className="watchdog-pc-actions">
                          <button
                            type="button"
                            className="btn btn-secondary"
                            disabled={wakingId === pc.id || !pc.mac.trim()}
                            onClick={() => void wakeNow(pc.id)}
                          >
                            {wakingId === pc.id ? "Waking…" : "Wake now"}
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost"
                            onClick={() => removePc(pc.id)}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={addPc}
                >
                  Add PC
                </button>
              </section>

              {message && (
                <div className="sync-alert sync-alert-ok">{message}</div>
              )}
            </>
          )}
        </div>

        <footer className="settings-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !serverUp || !settings}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </footer>
      </div>
    </div>
  );
}
