import { useCallback, useEffect, useState } from "react";

type PhotoDumpSettings = {
  enabled: boolean;
  rootPath: string;
  rootPathSet?: boolean;
  apiKey: string;
  apiKeySet?: boolean;
  maxFileBytes: number;
};

interface PhotoDumpSettingsSectionProps {
  serverUp: boolean | null;
}

export function PhotoDumpSettingsSection({
  serverUp,
}: PhotoDumpSettingsSectionProps) {
  const [settings, setSettings] = useState<PhotoDumpSettings | null>(null);
  const [rootPath, setRootPath] = useState("N:\\PhoneDump");
  const [enabled, setEnabled] = useState(true);
  const [plainKey, setPlainKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    type: "ok" | "err";
    text: string;
  } | null>(null);

  const load = useCallback(async () => {
    if (serverUp === false) return;
    try {
      const res = await fetch("/api/photo-dump/settings");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not load photo dump");
      const next = json.settings as PhotoDumpSettings;
      setSettings(next);
      setRootPath(next.rootPath || "N:\\PhoneDump");
      setEnabled(next.enabled !== false);
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

  const save = async (opts?: { rotateKey?: boolean }) => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/photo-dump/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled,
          rootPath,
          rotateKey: opts?.rotateKey === true,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      setSettings(json.settings as PhotoDumpSettings);
      if (typeof json.apiKeyPlain === "string" && json.apiKeyPlain) {
        setPlainKey(json.apiKeyPlain);
      }
      setMessage({
        type: "ok",
        text: opts?.rotateKey
          ? "New photo dump API key generated — copy it into Arrs Hub Mobile."
          : "Photo dump settings saved.",
      });
      await load();
    } catch (err) {
      setMessage({
        type: "err",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-group" id="photo-dump">
      <h3>Photo dump</h3>
      <p className="settings-hint">
        Receive photos/videos from Arrs Hub Mobile into a folder on this PC
        (e.g. <code>N:\PhoneDump</code>). Mobile can browse and create folders
        under this root only. Requires a port-forwarded Hub (same as Mobile
        status / WOL) and the API key below.
      </p>

      {serverUp === false && (
        <p className="settings-hint">
          Hub API is offline — start Arrs Hub to save photo dump settings.
        </p>
      )}

      <label className="toggle">
        <input
          type="checkbox"
          checked={enabled}
          disabled={serverUp === false || busy}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <span className="toggle-label">Enable photo dump uploads</span>
      </label>

      <label className="field">
        <span>Root folder on this PC</span>
        <input
          type="text"
          value={rootPath}
          disabled={serverUp === false || busy}
          placeholder="N:\PhoneDump"
          onChange={(e) => setRootPath(e.target.value)}
        />
      </label>

      <p className="settings-hint">
        API key{" "}
        {settings?.apiKeySet ? "(saved — generate a new one if needed)" : "(not set yet)"}
        {settings?.apiKey ? `: ${settings.apiKey}` : ""}
      </p>

      {plainKey && (
        <div className="sync-alert sync-alert-ok">
          <strong>Copy this key into Mobile now</strong> — it is only shown
          once:
          <br />
          <code style={{ userSelect: "all", wordBreak: "break-all" }}>
            {plainKey}
          </code>
        </div>
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
          disabled={serverUp === false || busy}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save photo dump"}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={serverUp === false || busy}
          onClick={() => void save({ rotateKey: true })}
        >
          Generate API key
        </button>
      </div>
    </section>
  );
}
