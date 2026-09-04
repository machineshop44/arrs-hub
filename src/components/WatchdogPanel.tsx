import { useCallback, useEffect, useState } from "react";
import { useModalBackdropClose } from "../hooks/useModalBackdropClose";

export type ServiceWatchConfig = {
  monitor: boolean;
  autoRestart: boolean;
  windowsService: string;
  exePath: string;
  restartPcId?: string;
};

export type PcWatchConfig = {
  id: string;
  name: string;
  host: string;
  mac: string;
  monitor: boolean;
  wakeOnLan: boolean;
  companionUrl?: string;
  companionApiKey?: string;
  companionApiKeySet?: boolean;
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
  /** Seconds after Hub start before Discord-down / auto-restart. */
  startupGraceSeconds?: number;
  startupGraceRemainingSeconds?: number;
  restartCooldownSeconds: number;
  autoRestart: boolean;
  wolEnabled: boolean;
  wolCooldownSeconds: number;
  discordWebhookSet?: boolean;
  discordNotifyDown?: boolean;
  discordNotifyRestart?: boolean;
  discordNotifyRecovered?: boolean;
  services: Record<string, ServiceWatchConfig>;
  pcs: PcWatchConfig[];
};

interface WatchdogPanelProps {
  onClose: () => void;
  serviceNames: { id: string; name: string; enabled: boolean }[];
  /** Full-page lite layout (no modal overlay). */
  embedded?: boolean;
  /** Downloader lite build — qBit/SAB defaults and Discord inline. */
  lite?: boolean;
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
    companionUrl: "",
    companionApiKey: "",
  };
}

export function WatchdogPanel({
  onClose,
  serviceNames,
  embedded = false,
  lite = false,
}: WatchdogPanelProps) {
  const backdrop = useModalBackdropClose(onClose);
  const [settings, setSettings] = useState<WatchdogSettings | null>(null);
  const [pcStatus, setPcStatus] = useState<Record<string, PcLiveStatus>>({});
  const [busy, setBusy] = useState(false);
  const [wakingId, setWakingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [serverUp, setServerUp] = useState<boolean | null>(null);
  const [discordWebhookUrl, setDiscordWebhookUrl] = useState("");
  const [discordNotifyDown, setDiscordNotifyDown] = useState(true);
  const [discordNotifyRestart, setDiscordNotifyRestart] = useState(true);
  const [discordNotifyRecovered, setDiscordNotifyRecovered] = useState(true);
  const [discordBusy, setDiscordBusy] = useState(false);

  const applyStatus = (json: {
    settings?: WatchdogSettings;
    pcs?: Record<string, PcLiveStatus>;
  }) => {
    if (json.settings) {
      const pcs = Array.isArray(json.settings.pcs)
        ? json.settings.pcs.map((pc: PcWatchConfig) => ({
            ...pc,
            companionApiKey: "",
          }))
        : [];
      setSettings({
        ...json.settings,
        wolEnabled: json.settings.wolEnabled !== false,
        wolCooldownSeconds: json.settings.wolCooldownSeconds || 300,
        pcs,
      });
      setDiscordWebhookUrl("");
      setDiscordNotifyDown(json.settings.discordNotifyDown !== false);
      setDiscordNotifyRestart(json.settings.discordNotifyRestart !== false);
      setDiscordNotifyRecovered(json.settings.discordNotifyRecovered !== false);
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
          startupGraceSeconds: settings.startupGraceSeconds ?? 120,
          restartCooldownSeconds: settings.restartCooldownSeconds,
          autoRestart: settings.autoRestart,
          wolEnabled: settings.wolEnabled,
          wolCooldownSeconds: settings.wolCooldownSeconds,
          discordWebhookUrl,
          discordNotifyDown,
          discordNotifyRestart,
          discordNotifyRecovered,
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
        restartPcId: "",
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

  const testDiscord = async () => {
    setDiscordBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/watchdog/discord-test", { method: "POST" });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        throw new Error(json.message || json.error || "Discord test failed");
      }
      setMessage(json.message || "Discord test sent.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setDiscordBusy(false);
    }
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

  const panelBody = (
    <div
      className={`settings-panel sync-panel${embedded ? " lite-main-panel" : ""}`}
      onClick={embedded ? undefined : (e) => e.stopPropagation()}
      role={embedded ? undefined : "dialog"}
      aria-labelledby="watchdog-title"
      aria-modal={embedded ? undefined : true}
    >
      <header className="settings-header">
        <h2 id="watchdog-title">
          {lite ? "Port watch, restart & alerts" : "Port watch & restart"}
        </h2>
        {!embedded && (
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        )}
      </header>

      <div className="settings-body">
          {serverUp === false && (
            <div className="sync-alert sync-alert-err">
              {lite
                ? "Hub server offline. Restart Arrs Hub Lite on this PC."
                : "Sync/watch server offline. Run npm run dev or start-hub.bat on this Plex PC."}
            </div>
          )}

          {serverUp && settings && (
            <>
              <section className="settings-group">
                <h3>{lite ? "Downloader watchdog" : "Plex PC watchdog"}</h3>
                <p className="settings-hint">
                  {lite ? (
                    <>
                      Keep Arr&apos;s Hub Lite on this downloader PC. It
                      watches qBittorrent and SABnzbd ports and can restart
                      their Windows services or default exe paths. Wake-on-LAN
                      below can power on another PC (e.g. Plex) — mobile can
                      relay through this hub when you&apos;re away.
                    </>
                  ) : (
                    <>
                      Keep Arr&apos;s Hub running on this PC. Status uses your
                      current link mode: <strong>Home</strong> ports when
                      Home/Auto says you&apos;re home (restart allowed),{" "}
                      <strong>Remote</strong> URLs when you&apos;re away (status
                      only — no remote restart). Prefer a Windows service name
                      when the app is installed as a service; optionally set an{" "}
                      <strong>exe path</strong> as fallback if the service
                      restart fails or no service is configured. Discord webhook
                      for down/restart alerts is under hub{" "}
                      <strong>Settings</strong>.
                    </>
                  )}
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
                <label className="field">
                  <span>Startup wait before restart (seconds)</span>
                  <input
                    type="number"
                    min={0}
                    max={600}
                    value={settings.startupGraceSeconds ?? 120}
                    onChange={(e) =>
                      setSettings((prev) =>
                        prev
                          ? {
                              ...prev,
                              startupGraceSeconds: Number(e.target.value) || 0,
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
                  {lite
                    ? "Default install paths for qBittorrent and SABnzbd are pre-filled. Edit only if yours differ."
                    : "Defaults use standard install paths (ProgramData for *arr; user profile where relevant) and can be edited. Empty fields only — your saved paths are never overwritten."}
                </p>
                <div className="sync-presets">
                  {apps.map((app) => {
                    const cfg = settings.services[app.id] ?? {
                      monitor: true,
                      autoRestart: false,
                      windowsService: "",
                      exePath: "",
                      restartPcId: "",
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
                        <label className="field">
                          <span>Restart on</span>
                          <select
                            value={cfg.restartPcId || ""}
                            onChange={(e) =>
                              updateService(app.id, {
                                restartPcId: e.target.value,
                              })
                            }
                          >
                            <option value="">This PC (Plex hub)</option>
                            {settings.pcs
                              .filter((pc) => pc.companionUrl?.trim())
                              .map((pc) => (
                                <option key={pc.id} value={pc.id}>
                                  Companion — {pc.name.trim() || pc.host || pc.id}
                                </option>
                              ))}
                          </select>
                        </label>
                        <p className="settings-hint">
                          {cfg.restartPcId
                            ? "Port checks use the service Home URL; restart runs on the Companion PC via LAN API."
                            : "Restart tries the Windows service first, then the exe path on this Plex PC."}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </section>

              <section className="settings-group">
                <h3>PC power &amp; Wake-on-LAN</h3>
                <p className="settings-hint">
                  Install <strong>Arrs Hub Companion</strong> on your downloader
                  PC — it scans the LAN, registers with this hub, and wires qBit /
                  SAB restarts automatically. Manual fields below are optional
                  overrides.
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
                        <label className="field">
                          <span>Companion URL (optional)</span>
                          <input
                            type="text"
                            value={pc.companionUrl || ""}
                            placeholder="http://192.168.1.50:3901"
                            onChange={(e) =>
                              updatePc(pc.id, { companionUrl: e.target.value })
                            }
                          />
                        </label>
                        <label className="field">
                          <span>
                            Companion API key
                            {pc.companionApiKeySet
                              ? " (saved — leave blank to keep)"
                              : ""}
                          </span>
                          <input
                            type="password"
                            autoComplete="off"
                            placeholder={
                              pc.companionApiKeySet
                                ? "•••• saved ••••"
                                : "Paste from Companion tray"
                            }
                            value={pc.companionApiKey || ""}
                            onChange={(e) =>
                              updatePc(pc.id, { companionApiKey: e.target.value })
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

              {lite && (
                <section className="settings-group">
                  <h3>Discord notifications</h3>
                  <p className="settings-hint">
                    Webhook alerts when a monitored port goes down, a restart
                    succeeds or fails, or the port recovers.
                  </p>
                  <label className="field">
                    <span>
                      Webhook URL
                      {settings.discordWebhookSet
                        ? " (saved — leave blank to keep)"
                        : ""}
                    </span>
                    <input
                      type="password"
                      autoComplete="off"
                      placeholder={
                        settings.discordWebhookSet
                          ? "•••• saved ••••"
                          : "https://discord.com/api/webhooks/…"
                      }
                      value={discordWebhookUrl}
                      disabled={discordBusy}
                      onChange={(e) => setDiscordWebhookUrl(e.target.value)}
                    />
                  </label>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={discordNotifyDown}
                      disabled={discordBusy}
                      onChange={(e) => setDiscordNotifyDown(e.target.checked)}
                    />
                    <span className="toggle-label">Notify when port goes down</span>
                  </label>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={discordNotifyRestart}
                      disabled={discordBusy}
                      onChange={(e) =>
                        setDiscordNotifyRestart(e.target.checked)
                      }
                    />
                    <span className="toggle-label">
                      Notify restart success / failure
                    </span>
                  </label>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={discordNotifyRecovered}
                      disabled={discordBusy}
                      onChange={(e) =>
                        setDiscordNotifyRecovered(e.target.checked)
                      }
                    />
                    <span className="toggle-label">
                      Notify when port comes back up
                    </span>
                  </label>
                  <div className="watchdog-bar-actions">
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={discordBusy}
                      onClick={() => void testDiscord()}
                    >
                      Send test
                    </button>
                  </div>
                </section>
              )}

              {message && (
                <div className="sync-alert sync-alert-ok">{message}</div>
              )}
            </>
          )}
        </div>

      <footer className="settings-footer">
        {!embedded && (
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
        )}
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
  );

  if (embedded) {
    return panelBody;
  }

  return (
    <div
      className="settings-overlay"
      role="presentation"
      onPointerDown={backdrop.onPointerDown}
      onPointerUp={backdrop.onPointerUp}
    >
      {panelBody}
    </div>
  );
}
