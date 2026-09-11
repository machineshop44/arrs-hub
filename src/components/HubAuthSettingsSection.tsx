import { useCallback, useEffect, useState } from "react";

type HubAuthSettings = {
  apiToken: string;
  apiTokenSet?: boolean;
  requireTokenForRemote: boolean;
};

interface HubAuthSettingsSectionProps {
  serverUp: boolean | null;
}

export function HubAuthSettingsSection({
  serverUp,
}: HubAuthSettingsSectionProps) {
  const [settings, setSettings] = useState<HubAuthSettings | null>(null);
  const [token, setToken] = useState("");
  const [requireToken, setRequireToken] = useState(true);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState<{
    type: "ok" | "err";
    text: string;
  } | null>(null);

  const load = useCallback(async () => {
    if (serverUp === false) return;
    try {
      const res = await fetch("/api/hub-auth/settings");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not load Hub API token");
      const next = json.settings as HubAuthSettings;
      setSettings(next);
      setToken(next.apiToken || "");
      setRequireToken(next.requireTokenForRemote !== false);
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

  const save = async (patch: Record<string, unknown>) => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/hub-auth/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not save Hub API token");
      const next = json.settings as HubAuthSettings;
      setSettings(next);
      setToken(next.apiToken || "");
      setRequireToken(next.requireTokenForRemote !== false);
      setMessage({
        type: "ok",
        text: patch.rotateToken
          ? "New Hub API token generated. Update Mobile if you use remote Hub APIs."
          : "Hub API token settings saved.",
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

  const copyToken = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setMessage({ type: "err", text: "Could not copy token to clipboard." });
    }
  };

  return (
    <section className="settings-group" id="hub-api-token">
      <h3>Hub API token</h3>
      <p className="settings-hint">
        Remote callers (phone / WAN on port 3000) must send{" "}
        <code>X-Arrs-Hub-Token</code> for Hub APIs. Localhost UI stays open.
        Photo dump keeps its own key (<code>X-Arrs-Hub-Key</code>).
      </p>
      {serverUp === false && (
        <p className="settings-error">
          Hub API is offline — start the hub server to manage the token.
        </p>
      )}
      <label className="toggle" style={{ marginBottom: "0.75rem" }}>
        <input
          type="checkbox"
          checked={requireToken}
          disabled={serverUp === false || busy}
          onChange={(e) => {
            setRequireToken(e.target.checked);
            void save({ requireTokenForRemote: e.target.checked });
          }}
        />
        <span>Require token for remote Hub API access</span>
      </label>
      <label className="field">
        <span>
          API token
          {settings?.apiTokenSet ? " (saved on this PC)" : ""}
        </span>
        <input
          type="text"
          readOnly
          autoComplete="off"
          value={token}
          placeholder={serverUp === false ? "Server offline" : "Generating…"}
          disabled={serverUp === false}
        />
      </label>
      <div className="settings-actions" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={serverUp === false || busy || !token}
          onClick={() => void copyToken()}
        >
          {copied ? "Copied" : "Copy token"}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={serverUp === false || busy}
          onClick={() => void save({ rotateToken: true })}
        >
          {busy ? "Working…" : "Regenerate token"}
        </button>
      </div>
      {message && (
        <div
          className={`sync-alert ${message.type === "ok" ? "sync-alert-ok" : "sync-alert-err"}`}
          style={{ marginTop: "0.75rem" }}
        >
          {message.text}
        </div>
      )}
    </section>
  );
}
