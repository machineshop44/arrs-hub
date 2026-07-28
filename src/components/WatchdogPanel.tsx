import { useCallback, useEffect, useState } from "react";

export type ServiceWatchConfig = {
  monitor: boolean;
  autoRestart: boolean;
  windowsService: string;
};

export type WatchdogSettings = {
  enabled: boolean;
  intervalSeconds: number;
  failThreshold: number;
  restartCooldownSeconds: number;
  autoRestart: boolean;
  discordWebhookUrl: string;
  discordWebhookSet?: boolean;
  discordNotifyDown: boolean;
  discordNotifyRestart: boolean;
  discordNotifyRecovered: boolean;
  services: Record<string, ServiceWatchConfig>;
};

interface WatchdogPanelProps {
  onClose: () => void;
  serviceNames: { id: string; name: string; enabled: boolean }[];
}

export function WatchdogPanel({ onClose, serviceNames }: WatchdogPanelProps) {
  const [settings, setSettings] = useState<WatchdogSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [serverUp, setServerUp] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    try {
      const health = await fetch("/api/health");
      setServerUp(health.ok);
      if (!health.ok) return;
      const res = await fetch("/api/watchdog/status");
      const json = await res.json();
      setSettings({
        ...json.settings,
        discordWebhookUrl: "",
        discordNotifyDown: json.settings?.discordNotifyDown !== false,
        discordNotifyRestart: json.settings?.discordNotifyRestart !== false,
        discordNotifyRecovered: json.settings?.discordNotifyRecovered !== false,
      });
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
        body: JSON.stringify(settings),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      setSettings({
        ...json.settings,
        discordWebhookUrl: "",
      });
      setMessage("Watchdog settings saved.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const testDiscord = async () => {
    setBusy(true);
    setMessage(null);
    try {
      // Save first so a freshly pasted webhook is used
      if (settings) {
        const saveRes = await fetch("/api/watchdog/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(settings),
        });
        const saveJson = await saveRes.json();
        if (!saveRes.ok) throw new Error(saveJson.error || "Save failed");
        setSettings({
          ...saveJson.settings,
          discordWebhookUrl: "",
        });
      }
      const res = await fetch("/api/watchdog/discord-test", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Test failed");
      setMessage("Test message sent to Discord.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
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

  const apps = serviceNames.filter(
    (service) => service.enabled && service.id !== "trash-guides",
  );

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
                  Keep Arr&apos;s Hub running on this PC. It checks each app&apos;s{" "}
                  <strong>Home</strong> port and can start the Windows service if
                  it goes down. Apps must be installed as Windows services
                  (Sonarr/Radarr installers usually offer that).
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
                <h3>Discord alerts</h3>
                <p className="settings-hint">
                  Paste a Discord channel webhook. Arrs Hub will ping you when a
                  monitored port goes down, and when an auto-restart succeeds or
                  fails — usually faster than waiting on Tautulli for Plex.
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
                    value={settings.discordWebhookUrl}
                    onChange={(e) =>
                      setSettings((prev) =>
                        prev
                          ? { ...prev, discordWebhookUrl: e.target.value }
                          : prev,
                      )
                    }
                  />
                </label>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={settings.discordNotifyDown}
                    onChange={(e) =>
                      setSettings((prev) =>
                        prev
                          ? { ...prev, discordNotifyDown: e.target.checked }
                          : prev,
                      )
                    }
                  />
                  <span className="toggle-label">Notify when port goes down</span>
                </label>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={settings.discordNotifyRestart}
                    onChange={(e) =>
                      setSettings((prev) =>
                        prev
                          ? { ...prev, discordNotifyRestart: e.target.checked }
                          : prev,
                      )
                    }
                  />
                  <span className="toggle-label">
                    Notify restart success / failure
                  </span>
                </label>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={settings.discordNotifyRecovered}
                    onChange={(e) =>
                      setSettings((prev) =>
                        prev
                          ? {
                              ...prev,
                              discordNotifyRecovered: e.target.checked,
                            }
                          : prev,
                      )
                    }
                  />
                  <span className="toggle-label">
                    Notify when port comes back up
                  </span>
                </label>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => void testDiscord()}
                >
                  Send test to Discord
                </button>
              </section>

              <section className="settings-group">
                <h3>Per app</h3>
                <div className="sync-presets">
                  {apps.map((app) => {
                    const cfg = settings.services[app.id] ?? {
                      monitor: true,
                      autoRestart: false,
                      windowsService: "",
                    };
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
                      </div>
                    );
                  })}
                </div>
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
