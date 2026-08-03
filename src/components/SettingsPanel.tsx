import { useCallback, useEffect, useState } from "react";
import type { AppSettings, ServiceConfig } from "../types";
import { APP_VERSION_LABEL } from "../version";
import { getServiceUrl } from "../types";

interface SettingsPanelProps {
  settings: AppSettings;
  onClose: () => void;
  onUpdateService: (id: string, updates: Partial<ServiceConfig>) => void;
  onUpdateTitle: (title: string) => void;
  onUpdateSubtitle: (subtitle: string) => void;
  onReset: () => void;
  /** Optional: open Streams panel (closes Settings) */
  onOpenStreams?: () => void;
}

export function SettingsPanel({
  settings,
  onClose,
  onUpdateService,
  onUpdateTitle,
  onUpdateSubtitle,
  onReset,
  onOpenStreams,
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

  const [discordWebhookUrl, setDiscordWebhookUrl] = useState("");
  const [discordWebhookSet, setDiscordWebhookSet] = useState(false);
  const [discordNotifyDown, setDiscordNotifyDown] = useState(true);
  const [discordNotifyRestart, setDiscordNotifyRestart] = useState(true);
  const [discordNotifyRecovered, setDiscordNotifyRecovered] = useState(true);
  const [discordBusy, setDiscordBusy] = useState(false);
  const [discordMessage, setDiscordMessage] = useState<{
    type: "ok" | "err";
    text: string;
  } | null>(null);

  const [qbUser, setQbUser] = useState("");
  const [qbPass, setQbPass] = useState("");
  const [qbPassSet, setQbPassSet] = useState(false);
  const [sabKey, setSabKey] = useState("");
  const [sabKeySet, setSabKeySet] = useState(false);
  const [ombiKey, setOmbiKey] = useState("");
  const [ombiKeySet, setOmbiKeySet] = useState(false);
  const [integrationsBusy, setIntegrationsBusy] = useState(false);
  const [integrationsMessage, setIntegrationsMessage] = useState<{
    type: "ok" | "err";
    text: string;
  } | null>(null);

  const [tautulliBaseUrl, setTautulliBaseUrl] = useState("");
  const [tautulliApiKey, setTautulliApiKey] = useState("");
  const [tautulliKeySet, setTautulliKeySet] = useState(false);
  const [tautulliBusy, setTautulliBusy] = useState(false);
  const [tautulliMessage, setTautulliMessage] = useState<{
    type: "ok" | "err";
    text: string;
  } | null>(null);

  const hubUrl = (id: string) => {
    const service = settings.services.find((s) => s.id === id);
    if (!service) return "";
    return getServiceUrl(service, "home") || service.homeUrl || service.defaultUrl;
  };

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

  const loadDiscord = useCallback(async () => {
    try {
      const health = await fetch("/api/health");
      setApiServerUp(health.ok);
      if (!health.ok) return;

      const res = await fetch("/api/watchdog/status");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not load Discord settings");

      setDiscordWebhookSet(Boolean(json.settings?.discordWebhookSet));
      setDiscordWebhookUrl("");
      setDiscordNotifyDown(json.settings?.discordNotifyDown !== false);
      setDiscordNotifyRestart(json.settings?.discordNotifyRestart !== false);
      setDiscordNotifyRecovered(json.settings?.discordNotifyRecovered !== false);
    } catch {
      setApiServerUp(false);
    }
  }, []);

  const loadIntegrations = useCallback(async () => {
    try {
      const health = await fetch("/api/health");
      setApiServerUp(health.ok);
      if (!health.ok) return;
      const res = await fetch("/api/integrations/settings");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not load integrations");
      setQbUser(json.settings?.qbittorrent?.username || "");
      setQbPass("");
      setQbPassSet(Boolean(json.settings?.qbittorrent?.passwordSet));
      setSabKey("");
      setSabKeySet(Boolean(json.settings?.sabnzbd?.apiKeySet));
      setOmbiKey("");
      setOmbiKeySet(Boolean(json.settings?.ombi?.apiKeySet));
    } catch {
      setApiServerUp(false);
    }
  }, []);

  const loadTautulli = useCallback(async () => {
    try {
      const health = await fetch("/api/health");
      setApiServerUp(health.ok);
      if (!health.ok) return;
      const res = await fetch("/api/tautulli/settings");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not load Tautulli settings");
      const saved = String(json.settings?.baseUrl || "").trim();
      const hub = hubUrl("tautulli");
      setTautulliBaseUrl(saved || hub || "http://localhost:8181");
      setTautulliApiKey("");
      setTautulliKeySet(Boolean(json.settings?.apiKeySet));
    } catch {
      setApiServerUp(false);
    }
  }, [settings.services]);

  useEffect(() => {
    void loadApiKeys();
    void loadDiscord();
    void loadIntegrations();
    void loadTautulli();
  }, [loadApiKeys, loadDiscord, loadIntegrations, loadTautulli]);

  const saveApiKeys = async () => {
    setApiBusy(true);
    setApiMessage(null);
    try {
      const res = await fetch("/api/sync/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sonarr: { apiKey: sonarrApiKey, baseUrl: hubUrl("sonarr") },
          radarr: { apiKey: radarrApiKey, baseUrl: hubUrl("radarr") },
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      setApiMessage({
        type: "ok",
        text: "API keys saved on this PC (used by TRaSH Sync + *arr queue chip).",
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

  const saveIntegrations = async () => {
    setIntegrationsBusy(true);
    setIntegrationsMessage(null);
    try {
      const res = await fetch("/api/integrations/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          qbittorrent: {
            baseUrl: hubUrl("qbittorrent"),
            username: qbUser,
            password: qbPass,
          },
          sabnzbd: {
            baseUrl: hubUrl("sabnzbd"),
            apiKey: sabKey,
          },
          ombi: {
            baseUrl: hubUrl("ombi"),
            apiKey: ombiKey,
          },
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      setIntegrationsMessage({
        type: "ok",
        text: "Download / Ombi credentials saved (dashboard status chips).",
      });
      await loadIntegrations();
    } catch (err) {
      setIntegrationsMessage({
        type: "err",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIntegrationsBusy(false);
    }
  };

  const saveTautulli = async () => {
    setTautulliBusy(true);
    setTautulliMessage(null);
    try {
      const res = await fetch("/api/tautulli/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl:
            tautulliBaseUrl.trim() ||
            hubUrl("tautulli") ||
            "http://localhost:8181",
          apiKey: tautulliApiKey,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      setTautulliMessage({
        type: "ok",
        text: "Tautulli settings saved on this PC (same file Streams uses).",
      });
      await loadTautulli();
    } catch (err) {
      setTautulliMessage({
        type: "err",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTautulliBusy(false);
    }
  };

  const saveDiscord = async () => {
    setDiscordBusy(true);
    setDiscordMessage(null);
    try {
      const res = await fetch("/api/watchdog/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          discordWebhookUrl,
          discordNotifyDown,
          discordNotifyRestart,
          discordNotifyRecovered,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      setDiscordMessage({
        type: "ok",
        text: "Discord webhook saved (used by Port Watch).",
      });
      await loadDiscord();
    } catch (err) {
      setDiscordMessage({
        type: "err",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setDiscordBusy(false);
    }
  };

  const testDiscord = async () => {
    setDiscordBusy(true);
    setDiscordMessage(null);
    try {
      const saveRes = await fetch("/api/watchdog/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          discordWebhookUrl,
          discordNotifyDown,
          discordNotifyRestart,
          discordNotifyRecovered,
        }),
      });
      const saveJson = await saveRes.json();
      if (!saveRes.ok) throw new Error(saveJson.error || "Save failed");
      await loadDiscord();

      const res = await fetch("/api/watchdog/discord-test", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Test failed");
      setDiscordMessage({ type: "ok", text: "Test message sent to Discord." });
    } catch (err) {
      setDiscordMessage({
        type: "err",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setDiscordBusy(false);
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
              Used by Recyclarr and the dashboard *arr queue chip for Sonarr
              and Radarr. Keys stay on this PC under the hub&apos;s local data
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

          <section className="settings-group">
            <h3>Tautulli</h3>
            <p className="settings-hint">
              Base URL and API key from{" "}
              <strong>Tautulli → Settings → Web Interface → API</strong>.
              Leave the key blank to keep the saved value. Also used by Streams
              and the dashboard stream count.
            </p>
            {apiServerUp === false && (
              <p className="settings-hint">
                Hub API is offline — start the hub server to save Tautulli
                settings.
              </p>
            )}
            <label className="field">
              <span>Tautulli base URL</span>
              <input
                type="text"
                autoComplete="off"
                placeholder="http://localhost:8181"
                value={tautulliBaseUrl}
                disabled={apiServerUp === false || tautulliBusy}
                onChange={(e) => setTautulliBaseUrl(e.target.value)}
              />
            </label>
            <label className="field">
              <span>
                Tautulli API key
                {tautulliKeySet ? " (saved — leave blank to keep)" : ""}
              </span>
              <input
                type="password"
                autoComplete="off"
                placeholder={
                  tautulliKeySet ? "•••• saved ••••" : "Paste API key"
                }
                value={tautulliApiKey}
                disabled={apiServerUp === false || tautulliBusy}
                onChange={(e) => setTautulliApiKey(e.target.value)}
              />
            </label>
            {tautulliMessage && (
              <div
                className={`sync-alert ${tautulliMessage.type === "ok" ? "sync-alert-ok" : "sync-alert-err"}`}
              >
                {tautulliMessage.text}
              </div>
            )}
            <div className="watchdog-bar-actions">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={apiServerUp === false || tautulliBusy}
                onClick={() => void saveTautulli()}
              >
                {tautulliBusy ? "Saving…" : "Save Tautulli settings"}
              </button>
              {onOpenStreams && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={onOpenStreams}
                >
                  Open Streams
                </button>
              )}
            </div>
          </section>

          <section className="settings-group">
            <h3>Downloads &amp; Ombi</h3>
            <p className="settings-hint">
              Optional credentials for dashboard chips (active downloads and
              open Ombi requests). URLs come from each service&apos;s Home
              address above.
            </p>
            <label className="field">
              <span>qBittorrent username</span>
              <input
                type="text"
                autoComplete="off"
                value={qbUser}
                disabled={apiServerUp === false || integrationsBusy}
                onChange={(e) => setQbUser(e.target.value)}
              />
            </label>
            <label className="field">
              <span>
                qBittorrent password
                {qbPassSet ? " (saved — leave blank to keep)" : ""}
              </span>
              <input
                type="password"
                autoComplete="off"
                placeholder={qbPassSet ? "•••• saved ••••" : "Password"}
                value={qbPass}
                disabled={apiServerUp === false || integrationsBusy}
                onChange={(e) => setQbPass(e.target.value)}
              />
            </label>
            <label className="field">
              <span>
                SABnzbd API key
                {sabKeySet ? " (saved — leave blank to keep)" : ""}
              </span>
              <input
                type="password"
                autoComplete="off"
                placeholder={sabKeySet ? "•••• saved ••••" : "Paste API key"}
                value={sabKey}
                disabled={apiServerUp === false || integrationsBusy}
                onChange={(e) => setSabKey(e.target.value)}
              />
            </label>
            <label className="field">
              <span>
                Ombi API key
                {ombiKeySet ? " (saved — leave blank to keep)" : ""}
              </span>
              <input
                type="password"
                autoComplete="off"
                placeholder={ombiKeySet ? "•••• saved ••••" : "Paste API key"}
                value={ombiKey}
                disabled={apiServerUp === false || integrationsBusy}
                onChange={(e) => setOmbiKey(e.target.value)}
              />
            </label>
            {integrationsMessage && (
              <div
                className={`sync-alert ${integrationsMessage.type === "ok" ? "sync-alert-ok" : "sync-alert-err"}`}
              >
                {integrationsMessage.text}
              </div>
            )}
            <button
              type="button"
              className="btn btn-secondary"
              disabled={apiServerUp === false || integrationsBusy}
              onClick={() => void saveIntegrations()}
            >
              {integrationsBusy ? "Saving…" : "Save download / Ombi creds"}
            </button>
          </section>

          <section className="settings-group">
            <h3>Discord notifications</h3>
            <p className="settings-hint">
              Webhook for Port Watch: when a monitored app port goes down, a
              restart succeeds or fails, or the port comes back up. Discord is
              not scanned — only your Sonarr/Radarr/Plex/etc. ports are.
            </p>
            {apiServerUp === false && (
              <p className="settings-hint">
                Hub API is offline — start the hub server to save the webhook.
              </p>
            )}
            <label className="field">
              <span>
                Webhook URL
                {discordWebhookSet ? " (saved — leave blank to keep)" : ""}
              </span>
              <input
                type="password"
                autoComplete="off"
                placeholder={
                  discordWebhookSet
                    ? "•••• saved ••••"
                    : "https://discord.com/api/webhooks/…"
                }
                value={discordWebhookUrl}
                disabled={apiServerUp === false || discordBusy}
                onChange={(e) => setDiscordWebhookUrl(e.target.value)}
              />
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={discordNotifyDown}
                disabled={apiServerUp === false || discordBusy}
                onChange={(e) => setDiscordNotifyDown(e.target.checked)}
              />
              <span className="toggle-label">Notify when port goes down</span>
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={discordNotifyRestart}
                disabled={apiServerUp === false || discordBusy}
                onChange={(e) => setDiscordNotifyRestart(e.target.checked)}
              />
              <span className="toggle-label">
                Notify restart success / failure
              </span>
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={discordNotifyRecovered}
                disabled={apiServerUp === false || discordBusy}
                onChange={(e) => setDiscordNotifyRecovered(e.target.checked)}
              />
              <span className="toggle-label">Notify when port comes back up</span>
            </label>
            {discordMessage && (
              <div
                className={`sync-alert ${discordMessage.type === "ok" ? "sync-alert-ok" : "sync-alert-err"}`}
              >
                {discordMessage.text}
              </div>
            )}
            <div className="watchdog-bar-actions">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={apiServerUp === false || discordBusy}
                onClick={() => void saveDiscord()}
              >
                {discordBusy ? "Saving…" : "Save Discord settings"}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={apiServerUp === false || discordBusy}
                onClick={() => void testDiscord()}
              >
                Send test
              </button>
            </div>
          </section>

          <p className="settings-version" aria-label="App version">
            {APP_VERSION_LABEL}
          </p>
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
