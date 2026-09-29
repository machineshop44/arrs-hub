import { useCallback, useEffect, useRef, useState } from "react";
import type { AppSettings, ServiceConfig } from "../types";
import { APP_VERSION_LABEL } from "../version";
import { MonitorSettingsSection } from "./MonitorSettingsSection";
import { PlexUpdateCard } from "./PlexUpdateCard";
import {
  AppsMonitoringSection,
  type AppsMonitoringHandle,
} from "./AppsMonitoringSection";
import { PhotoDumpSettingsSection } from "./PhotoDumpSettingsSection";
import { HubAuthSettingsSection } from "./HubAuthSettingsSection";
import { NtfySettingsSection } from "./NtfySettingsSection";
import { useModalBackdropClose } from "../hooks/useModalBackdropClose";

interface SettingsPanelProps {
  settings: AppSettings;
  onClose: () => void;
  onUpdateService: (id: string, updates: Partial<ServiceConfig>) => void;
  onUpdateTitle: (title: string) => void;
  onUpdateSubtitle: (subtitle: string) => void;
  onReset: () => void;
  /** Optional: open Streams panel (closes Settings) */
  onOpenStreams?: () => void;
  /** Scroll to section id on open (e.g. apps-monitoring from Port Watch) */
  initialSection?: string | null;
  /** Swap the host on every saved Remote URL (ports/paths kept). */
  onApplyRemoteHost?: (host: string) => void;
}

function currentRemoteHost(services: ServiceConfig[]): string {
  for (const service of services) {
    try {
      if (service.remoteUrl.trim()) return new URL(service.remoteUrl).hostname;
    } catch {
      // try the next one
    }
  }
  return "";
}

export function SettingsPanel({
  settings,
  onClose,
  onUpdateService,
  onUpdateTitle,
  onUpdateSubtitle,
  onReset,
  onOpenStreams,
  initialSection = null,
  onApplyRemoteHost,
}: SettingsPanelProps) {
  const appsMonitorRef = useRef<AppsMonitoringHandle | null>(null);

  const handleDone = useCallback(async () => {
    try {
      await appsMonitorRef.current?.flushCredentials();
    } catch {
      // still close
    }
    onClose();
  }, [onClose]);

  const backdrop = useModalBackdropClose(() => {
    void handleDone();
  });

  const [remoteHost, setRemoteHost] = useState(() =>
    currentRemoteHost(settings.services),
  );
  const [remoteHostMsg, setRemoteHostMsg] = useState<string | null>(null);
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

  const loadDiscord = useCallback(async () => {
    try {
      const res = await fetch("/api/watchdog/status");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not load Discord settings");

      setDiscordWebhookSet(Boolean(json.settings?.discordWebhookSet));
      setDiscordWebhookUrl("");
      setDiscordNotifyDown(json.settings?.discordNotifyDown !== false);
      setDiscordNotifyRestart(json.settings?.discordNotifyRestart !== false);
      setDiscordNotifyRecovered(json.settings?.discordNotifyRecovered !== false);
    } catch {
      // Discord settings are optional — do not mark Hub API down.
    }
  }, []);

  const probeApiHealth = useCallback(async () => {
    try {
      const health = await fetch("/api/health");
      setApiServerUp(health.ok);
    } catch {
      setApiServerUp(false);
    }
  }, []);

  useEffect(() => {
    if (!initialSection) return;
    const timer = window.setTimeout(() => {
      document.getElementById(initialSection)?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [initialSection]);

  useEffect(() => {
    void probeApiHealth();
    void loadDiscord();
  }, [loadDiscord, probeApiHealth]);

  const applyRemoteHost = () => {
    const host = remoteHost.trim();
    if (!host || !onApplyRemoteHost) return;
    const count = settings.services.filter((s) => s.remoteUrl.trim()).length;
    onApplyRemoteHost(host);
    setRemoteHostMsg(`Updated ${count} remote URL${count === 1 ? "" : "s"} to ${host}.`);
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
    <div
      className="settings-overlay"
      role="presentation"
      onPointerDown={backdrop.onPointerDown}
      onPointerUp={backdrop.onPointerUp}
    >
      <div
        className="settings-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="settings-title"
        aria-modal="true"
      >
        <header className="settings-header">
          <h2 id="settings-title">Settings</h2>
          <button type="button" className="icon-btn" onClick={() => void handleDone()} aria-label="Close settings">
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
            <h3>Hub network (phone / LAN)</h3>
            <p className="settings-hint">
              {"The Hub API must listen on the LAN so Arrs Hub Mobile and remote chips can connect. Default bind is 0.0.0.0 (all interfaces) on port 3000 in the desktop app."}
            </p>
            <ul className="settings-hint-list">
              <li>
                Keep <code>ARRS_HUB_BIND=0.0.0.0</code> (or unset — that is the
                default). Use <code>127.0.0.1</code> only if you want
                localhost-only.
              </li>
              <li>
                Optional port: <code>ARRS_HUB_PORT</code> (or{" "}
                <code>PORT</code>).
              </li>
              <li>
                For phones off-LAN, port-forward TCP <strong>3000</strong> to
                this PC (same idea as Sonarr/Radarr). The dashboard{" "}
                <strong>Hub</strong> chip shows listen address and version.
              </li>
            </ul>
            {apiServerUp === false && (
              <p className="settings-error">
                Hub API is offline right now — start Arrs Hub before mobile can
                connect.
              </p>
            )}
            {apiServerUp === true && (
              <p className="settings-ok">
                Hub API is online. Check the <strong>Hub</strong> chip on the
                dashboard for bind / port.
              </p>
            )}
          </section>

          <section className="settings-group">
            <h3>Remote host (away from home)</h3>
            <p className="settings-hint">
              Public IP or DDNS name (e.g. <code>myplex.duckdns.org</code>) used
              by every app&apos;s Remote URL. Changing it here rewrites the host
              on all saved Remote URLs and keeps each app&apos;s port and path.
            </p>
            <label className="field">
              <span>Host</span>
              <input
                type="text"
                value={remoteHost}
                placeholder="myplex.duckdns.org or 203.0.113.10"
                onChange={(e) => {
                  setRemoteHost(e.target.value);
                  setRemoteHostMsg(null);
                }}
              />
            </label>
            {remoteHostMsg && <p className="settings-ok">{remoteHostMsg}</p>}
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!remoteHost.trim() || !onApplyRemoteHost}
              onClick={applyRemoteHost}
            >
              Apply to all Remote URLs
            </button>
          </section>

          <AppsMonitoringSection
            ref={appsMonitorRef}
            settings={settings}
            onUpdateService={onUpdateService}
            serverUp={apiServerUp}
            onOpenStreams={onOpenStreams}
          />

          <HubAuthSettingsSection serverUp={apiServerUp} />

          <PhotoDumpSettingsSection serverUp={apiServerUp} />

          <PlexUpdateCard serverUp={apiServerUp} />

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

          <MonitorSettingsSection serverUp={apiServerUp} />

          <NtfySettingsSection serverUp={apiServerUp} />

          <p className="settings-version" aria-label="App version">
            {APP_VERSION_LABEL}
          </p>
        </div>

        <footer className="settings-footer">
          <button type="button" className="btn btn-secondary" onClick={onReset}>
            Reset to defaults
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void handleDone()}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
