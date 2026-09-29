import { useCallback, useEffect, useState } from "react";

type NtfyEvents = {
  ombiPending: boolean;
  queueIssues: boolean;
  serviceDown: boolean;
  serviceUp: boolean;
};

type NtfySettings = {
  enabled: boolean;
  serverUrl: string;
  topic: string;
  accessToken: string;
  accessTokenSet: boolean;
  clickUrl: string;
  intervalSeconds: number;
  serviceDebounceSeconds: number;
  serviceCooldownSeconds: number;
  events: NtfyEvents;
};

type NtfyStatus = {
  active: boolean;
  lastRunAt: string | null;
  lastSentAt: string | null;
  lastError: string | null;
};

const EVENT_LABELS: { key: keyof NtfyEvents; label: string }[] = [
  { key: "ombiPending", label: "New Ombi request waiting for approval" },
  {
    key: "queueIssues",
    label: "*arr download failed, stuck, or needs manual import",
  },
  { key: "serviceDown", label: "Port Watch service goes down (high priority)" },
  { key: "serviceUp", label: "Port Watch service comes back up" },
];

interface NtfySettingsSectionProps {
  serverUp: boolean | null;
}

export function NtfySettingsSection({ serverUp }: NtfySettingsSectionProps) {
  const [enabled, setEnabled] = useState(false);
  const [serverUrl, setServerUrl] = useState("https://ntfy.sh");
  const [topic, setTopic] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [accessTokenSet, setAccessTokenSet] = useState(false);
  const [clickUrl, setClickUrl] = useState("");
  const [events, setEvents] = useState<NtfyEvents>({
    ombiPending: true,
    queueIssues: true,
    serviceDown: true,
    serviceUp: true,
  });
  const [status, setStatus] = useState<NtfyStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    type: "ok" | "err";
    text: string;
  } | null>(null);

  const apply = (settings: NtfySettings, nextStatus?: NtfyStatus) => {
    setEnabled(Boolean(settings.enabled));
    setServerUrl(settings.serverUrl || "https://ntfy.sh");
    setTopic(settings.topic || "");
    setAccessToken("");
    setAccessTokenSet(Boolean(settings.accessTokenSet));
    setClickUrl(settings.clickUrl || "");
    setEvents({ ...settings.events });
    if (nextStatus) setStatus(nextStatus);
  };

  const load = useCallback(async () => {
    if (serverUp === false) return;
    try {
      const res = await fetch("/api/ntfy/settings");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not load ntfy settings");
      apply(json.settings as NtfySettings, json.status as NtfyStatus);
    } catch (err) {
      setMessage({
        type: "err",
        text: err instanceof Error ? err.message : String(err),
      });
    }
  }, [serverUp]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (): Promise<boolean> => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/ntfy/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled,
          serverUrl,
          topic,
          accessToken,
          clickUrl,
          events,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not save ntfy settings");
      apply(json.settings as NtfySettings, json.status as NtfyStatus);
      setMessage({ type: "ok", text: "ntfy settings saved." });
      return true;
    } catch (err) {
      setMessage({
        type: "err",
        text: err instanceof Error ? err.message : String(err),
      });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    if (!(await save())) return;
    setBusy(true);
    try {
      const res = await fetch("/api/ntfy/test", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "ntfy test failed");
      setMessage({
        type: "ok",
        text: "Test sent — check the ntfy app on your phone.",
      });
    } catch (err) {
      setMessage({
        type: "err",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const disabled = serverUp === false || busy;

  return (
    <section className="settings-group" id="ntfy-alerts">
      <h3>Phone push alerts (ntfy)</h3>
      <p className="settings-hint">
        The Hub checks every couple of minutes and pushes to the ntfy app on
        your phone. Subscribe to the same topic in the ntfy app. Pick a long,
        hard-to-guess topic on ntfy.sh (anyone who knows it can read alerts),
        or use your own server with an access token.
      </p>
      {serverUp === false && (
        <p className="settings-hint">
          Hub API is offline — start the hub server to save ntfy settings.
        </p>
      )}
      <label className="toggle" style={{ marginBottom: "0.75rem" }}>
        <input
          type="checkbox"
          checked={enabled}
          disabled={disabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <span className="toggle-label">Send ntfy alerts</span>
      </label>
      <label className="field">
        <span>Server URL</span>
        <input
          type="url"
          autoComplete="off"
          placeholder="https://ntfy.sh"
          value={serverUrl}
          disabled={disabled}
          onChange={(e) => setServerUrl(e.target.value)}
        />
      </label>
      <label className="field">
        <span>Topic</span>
        <input
          type="text"
          autoComplete="off"
          placeholder="arrs-hub-andrew-8f3k2"
          value={topic}
          disabled={disabled}
          onChange={(e) => setTopic(e.target.value)}
        />
      </label>
      <label className="field">
        <span>
          Access token (optional)
          {accessTokenSet ? " (saved — leave blank to keep)" : ""}
        </span>
        <input
          type="password"
          autoComplete="off"
          placeholder={accessTokenSet ? "•••• saved ••••" : "tk_…"}
          value={accessToken}
          disabled={disabled}
          onChange={(e) => setAccessToken(e.target.value)}
        />
      </label>
      <label className="field">
        <span>Tap-to-open URL (optional)</span>
        <input
          type="url"
          autoComplete="off"
          placeholder="http://192.168.1.10:3000"
          value={clickUrl}
          disabled={disabled}
          onChange={(e) => setClickUrl(e.target.value)}
        />
      </label>
      {EVENT_LABELS.map(({ key, label }) => (
        <label className="toggle" key={key}>
          <input
            type="checkbox"
            checked={events[key]}
            disabled={disabled}
            onChange={(e) =>
              setEvents((prev) => ({ ...prev, [key]: e.target.checked }))
            }
          />
          <span className="toggle-label">{label}</span>
        </label>
      ))}
      {status && (status.lastSentAt || status.lastError) && (
        <p className="settings-hint">
          {status.lastSentAt
            ? `Last alert sent ${new Date(status.lastSentAt).toLocaleString()}.`
            : ""}
          {status.lastError ? ` Last error: ${status.lastError}` : ""}
        </p>
      )}
      {message && (
        <div
          className={`sync-alert ${message.type === "ok" ? "sync-alert-ok" : "sync-alert-err"}`}
        >
          {message.text}
        </div>
      )}
      <div className="watchdog-bar-actions">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={disabled}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save ntfy settings"}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={disabled || !topic.trim()}
          onClick={() => void sendTest()}
        >
          Send test
        </button>
      </div>
    </section>
  );
}
