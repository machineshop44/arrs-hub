import { useCallback, useEffect, useState } from "react";
import type { AppSettings, ServiceConfig } from "../types";

interface SettingsPanelProps {
  settings: AppSettings;
  onClose: () => void;
  onUpdateService: (id: string, updates: Partial<ServiceConfig>) => void;
  onUpdateTitle: (title: string) => void;
  onUpdateSubtitle: (subtitle: string) => void;
  onReset: () => void;
}

export function SettingsPanel({
  settings,
  onClose,
  onUpdateService,
  onUpdateTitle,
  onUpdateSubtitle,
  onReset,
}: SettingsPanelProps) {
  const [sonarrApiKey, setSonarrApiKey] = useState("");
  const [radarrApiKey, setRadarrApiKey] = useState("");
  const [sonarrKeySet, setSonarrKeySet] = useState(false);
  const [radarrKeySet, setRadarrKeySet] = useState(false);
  const [apiBusy, setApiBusy] = useState(false);
  const [apiMessage, setApiMessage] = useState<{
    type: "ok" | "err";
    text: string;
  } | null>(null);
  const [apiServerUp, setApiServerUp] = useState<boolean | null>(null);

  const loadApiKeys = useCallback(async () => {
    try {
      const health = await fetch("/api/health");
      setApiServerUp(health.ok);
      if (!health.ok) return;

      const res = await fetch("/api/sync/settings");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not load API keys");

      setSonarrKeySet(Boolean(json.settings?.sonarr?.apiKeySet));
      setRadarrKeySet(Boolean(json.settings?.radarr?.apiKeySet));
      setSonarrApiKey("");
      setRadarrApiKey("");
    } catch {
      setApiServerUp(false);
    }
  }, []);

  useEffect(() => {
    void loadApiKeys();
  }, [loadApiKeys]);

  const saveApiKeys = async () => {
    setApiBusy(true);
    setApiMessage(null);
    try {
      const res = await fetch("/api/sync/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sonarr: { apiKey: sonarrApiKey },
          radarr: { apiKey: radarrApiKey },
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      setApiMessage({
        type: "ok",
        text: "API keys saved on this PC (used by TRaSH Sync).",
      });
      await loadApiKeys();
    } catch (err) {
      setApiMessage({
        type: "err",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setApiBusy(false);
    }
  };

  return (
    <div className="settings-overlay" onClick={onClose} role="presentation">
      <div
        className="settings-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="settings-title"
        aria-modal="true"
      >
        <header className="settings-header">
          <h2 id="settings-title">Settings</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close settings">
            ✕
          </button>
        </header>

        <div className="settings-body">
          <section className="settings-group">
            <h3>Dashboard</h3>
            <label className="field">
              <span>Title</span>
              <input
                type="text"
                value={settings.title}
                onChange={(e) => onUpdateTitle(e.target.value)}
              />
            </label>
            <label className="field">
              <span>Subtitle</span>
              <input
                type="text"
                value={settings.subtitle}
                onChange={(e) => onUpdateSubtitle(e.target.value)}
              />
            </label>
          </section>

          <section className="settings-group">
            <h3>Services</h3>
            <p className="settings-hint">
              Enter a Home address (local IP &amp; port) and optional Remote
              address for each app. With <strong>Auto</strong> selected, the
              dashboard picks Home or Remote from your network — use Home/Remote
              in the header only if you need to override.
            </p>
            <div className="settings-services">
              {settings.services.map((service) => (
                <div key={service.id} className="settings-service-row">
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={service.enabled}
                      onChange={(e) =>
                        onUpdateService(service.id, { enabled: e.target.checked })
                      }
                    />
                    <span className="toggle-label">
                      {service.icon} {service.name}
                    </span>
                  </label>
                  <label className="field">
                    <span>Home (local IP &amp; port)</span>
                    <input
                      type="text"
                      className="url-input"
                      value={service.homeUrl}
                      placeholder="http://192.168.1.50:8989"
                      disabled={!service.enabled}
                      onChange={(e) =>
                        onUpdateService(service.id, { homeUrl: e.target.value })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>Remote (optional)</span>
                    <input
                      type="text"
                      className="url-input"
                      value={service.remoteUrl}
                      placeholder="https://sonarr.yourdomain.com"
                      disabled={!service.enabled}
                      onChange={(e) =>
                        onUpdateService(service.id, { remoteUrl: e.target.value })
                      }
                    />
                  </label>
                </div>
              ))}
            </div>
          </section>

          <section className="settings-group">
            <h3>TRaSH Sync API keys</h3>
            <p className="settings-hint">
              Used by Recyclarr for Sonarr and Radarr only (not Lidarr or
              Readarr). Keys stay on this PC under the hub&apos;s local data
              folder. Leave a field blank to keep the saved key.
            </p>
            {apiServerUp === false && (
              <p className="settings-hint">
                Hub API is offline — start the hub server to save API keys.
              </p>
            )}
            <label className="field">
              <span>
                Sonarr API key
                {sonarrKeySet ? " (saved — leave blank to keep)" : ""}
              </span>
              <input
                type="password"
                autoComplete="off"
                placeholder={sonarrKeySet ? "•••• saved ••••" : "Paste API key"}
                value={sonarrApiKey}
                disabled={apiServerUp === false || apiBusy}
                onChange={(e) => setSonarrApiKey(e.target.value)}
              />
            </label>
            <label className="field">
              <span>
                Radarr API key
                {radarrKeySet ? " (saved — leave blank to keep)" : ""}
              </span>
              <input
                type="password"
                autoComplete="off"
                placeholder={radarrKeySet ? "•••• saved ••••" : "Paste API key"}
                value={radarrApiKey}
                disabled={apiServerUp === false || apiBusy}
                onChange={(e) => setRadarrApiKey(e.target.value)}
              />
            </label>
            {apiMessage && (
              <div
                className={`sync-alert ${apiMessage.type === "ok" ? "sync-alert-ok" : "sync-alert-err"}`}
              >
                {apiMessage.text}
              </div>
            )}
            <button
              type="button"
              className="btn btn-secondary"
              disabled={apiServerUp === false || apiBusy}
              onClick={() => void saveApiKeys()}
            >
              {apiBusy ? "Saving…" : "Save API keys"}
            </button>
          </section>
        </div>

        <footer className="settings-footer">
          <button type="button" className="btn btn-secondary" onClick={onReset}>
            Reset to defaults
          </button>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
