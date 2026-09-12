import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";

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

function looksAbsoluteWindowsPath(value: string) {
  const v = value.trim();
  if (!v) return false;
  if (v.includes("..")) return false;
  return /^[a-zA-Z]:[\\/]/.test(v) || /^\\\\[^\\\/]+[\\/]/.test(v);
}

function looksHttpUrl(value: string) {
  try {
    const u = new URL(value.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function formatMaxBytesLabel(bytes: number) {
  const gib = bytes / (1024 * 1024 * 1024);
  if (gib >= 1) return `${gib % 1 === 0 ? gib.toFixed(0) : gib.toFixed(1)} GiB`;
  const mib = bytes / (1024 * 1024);
  return `${mib % 1 === 0 ? mib.toFixed(0) : mib.toFixed(1)} MiB`;
}

export function PhotoDumpSettingsSection({
  serverUp,
}: PhotoDumpSettingsSectionProps) {
  const [settings, setSettings] = useState<PhotoDumpSettings | null>(null);
  const [rootPath, setRootPath] = useState("N:\\PhoneDump");
  const [enabled, setEnabled] = useState(true);
  const [maxFileGib, setMaxFileGib] = useState("2");
  const [pairUrl, setPairUrl] = useState("");
  const [plainKey, setPlainKey] = useState<string | null>(null);
  const [pairPayload, setPairPayload] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [hubTokenInQr, setHubTokenInQr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    type: "ok" | "err";
    text: string;
  } | null>(null);

  const loadPairHint = useCallback(async () => {
    if (serverUp === false) return;
    try {
      const res = await fetch("/api/photo-dump/pair-hint");
      const json = await res.json();
      if (!res.ok) return;
      const preferred =
        (typeof json.preferredUrl === "string" && json.preferredUrl) ||
        (typeof json.publicUrl === "string" && json.publicUrl) ||
        (typeof json.lanUrl === "string" && json.lanUrl) ||
        "";
      if (preferred) {
        setPairUrl((prev) => prev || preferred);
      }
    } catch {
      // ignore
    }
  }, [serverUp]);

  const refreshSetupQr = useCallback(
    async (urlOverride?: string) => {
      if (serverUp === false) return;
      const url = (urlOverride ?? pairUrl).trim();
      try {
        const qs = url ? `?pairUrl=${encodeURIComponent(url)}` : "";
        const res = await fetch(`/api/photo-dump/setup-qr${qs}`);
        const json = await res.json();
        if (!res.ok) {
          setPairPayload(null);
          setHubTokenInQr(false);
          return;
        }
        if (typeof json.pairUrl === "string" && json.pairUrl) {
          setPairUrl((prev) => prev.trim() || json.pairUrl);
        }
        setPairPayload(
          typeof json.pairPayload === "string" ? json.pairPayload : null,
        );
        setHubTokenInQr(Boolean(json.hubTokenSet));
      } catch {
        setPairPayload(null);
      }
    },
    [serverUp, pairUrl],
  );

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
      if (next.maxFileBytes > 0) {
        const gib = next.maxFileBytes / (1024 * 1024 * 1024);
        setMaxFileGib(String(gib % 1 === 0 ? gib : Number(gib.toFixed(2))));
      }
    } catch (err) {
      setMessage({
        type: "err",
        text: err instanceof Error ? err.message : String(err),
      });
    }
  }, [serverUp]);

  useEffect(() => {
    void load();
    void loadPairHint();
  }, [load, loadPairHint]);

  // Show QR whenever a photo key exists and we have (or get) a Hub URL.
  useEffect(() => {
    if (serverUp === false || !settings?.apiKeySet) {
      setPairPayload(null);
      return;
    }
    const t = setTimeout(() => {
      void refreshSetupQr();
    }, 200);
    return () => clearTimeout(t);
  }, [serverUp, settings?.apiKeySet, pairUrl, refreshSetupQr]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!pairPayload) {
        setQrDataUrl(null);
        return;
      }
      try {
        const url = await QRCode.toDataURL(pairPayload, {
          errorCorrectionLevel: "M",
          margin: 2,
          width: 240,
          color: { dark: "#111111", light: "#ffffff" },
        });
        if (!cancelled) setQrDataUrl(url);
      } catch {
        if (!cancelled) setQrDataUrl(null);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [pairPayload]);

  const save = async (opts?: { rotateKey?: boolean }) => {
    setBusy(true);
    setMessage(null);
    try {
      if (!looksAbsoluteWindowsPath(rootPath)) {
        throw new Error(
          "Root path must be absolute (e.g. N:\\PhoneDump or \\\\server\\share\\PhoneDump).",
        );
      }
      if (opts?.rotateKey && pairUrl.trim() && !looksHttpUrl(pairUrl)) {
        throw new Error(
          "Hub URL for Mobile QR must be http:// or https:// (LAN or public).",
        );
      }
      const gib = Number(maxFileGib);
      const maxFileBytes =
        Number.isFinite(gib) && gib > 0
          ? Math.max(1_000_000, Math.round(gib * 1024 * 1024 * 1024))
          : undefined;
      const res = await fetch("/api/photo-dump/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled,
          rootPath,
          maxFileBytes,
          rotateKey: opts?.rotateKey === true,
          pairUrl: pairUrl.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      setSettings(json.settings as PhotoDumpSettings);
      if (typeof json.pairHint?.preferredUrl === "string" && !pairUrl.trim()) {
        setPairUrl(json.pairHint.preferredUrl);
      } else if (typeof json.pairHint?.lanUrl === "string" && !pairUrl.trim()) {
        setPairUrl(json.pairHint.lanUrl);
      }
      if (typeof json.apiKeyPlain === "string" && json.apiKeyPlain) {
        setPlainKey(json.apiKeyPlain);
      }
      if (typeof json.pairPayload === "string" && json.pairPayload) {
        setPairPayload(json.pairPayload);
        setHubTokenInQr(true);
      } else {
        await refreshSetupQr(pairUrl);
      }
      setMessage({
        type: "ok",
        text: opts?.rotateKey
          ? "New photo dump key generated — QR below includes photo key + Hub API token."
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

  const copyKey = async () => {
    if (!plainKey) return;
    try {
      await navigator.clipboard.writeText(plainKey);
      setMessage({ type: "ok", text: "API key copied to clipboard." });
    } catch {
      setMessage({
        type: "err",
        text: "Could not copy — select the key and copy manually.",
      });
    }
  };

  return (
    <section className="settings-group" id="photo-dump">
      <h3>Mobile setup QR</h3>
      <div className="sync-alert sync-alert-ok" style={{ marginBottom: "0.85rem" }}>
        <strong>One QR for both Mobile secrets</strong>
        <p className="settings-hint" style={{ marginTop: "0.35rem", marginBottom: 0 }}>
          Scan this QR in Arrs Hub Mobile to set{" "}
          <strong>(1) Photo dump key</strong> (<code>X-Arrs-Hub-Key</code>) and{" "}
          <strong>(2) Hub API token</strong> (<code>X-Arrs-Hub-Token</code>) at
          once. There is <strong>no separate QR</strong> under “Hub API token” —
          that section is copy/regenerate only. If the QR is missing, click{" "}
          <strong>Generate API key</strong> once, then it stays visible here.
        </p>
      </div>
      <p className="settings-hint">
        Receive photos/videos from Arrs Hub Mobile into a folder on this PC
        (e.g. <code>N:\PhoneDump</code>). Same Hub URL / port-forward as Mobile
        status.
      </p>

      {serverUp === false && (
        <p className="settings-hint">
          Hub API is offline — start Arrs Hub to manage photo dump / Mobile QR.
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

      <label className="field">
        <span>Max file size (GiB)</span>
        <input
          type="number"
          min={0.1}
          step={0.1}
          value={maxFileGib}
          disabled={serverUp === false || busy}
          onChange={(e) => setMaxFileGib(e.target.value)}
        />
      </label>
      {settings?.maxFileBytes ? (
        <p className="settings-hint">
          Current limit: {formatMaxBytesLabel(settings.maxFileBytes)}
        </p>
      ) : null}

      <label className="field">
        <span>Hub URL for Mobile QR</span>
        <input
          type="text"
          value={pairUrl}
          disabled={serverUp === false || busy}
          placeholder="http://your.public.ip:3000"
          onChange={(e) => setPairUrl(e.target.value)}
          onBlur={() => void refreshSetupQr()}
        />
      </label>
      <p className="settings-hint">
        Prefer your <strong>public/WAN</strong> IP (port-forward 3000). Mobile
        auto-switches to LAN on home Wi‑Fi.
      </p>

      <p className="settings-hint">
        Photo dump API key{" "}
        {settings?.apiKeySet
          ? "(saved — generate a new one if needed)"
          : "(not set yet — click Generate API key)"}
        {settings?.apiKey ? `: ${settings.apiKey}` : ""}
      </p>

      <div
        className="sync-alert sync-alert-ok"
        style={{ marginTop: "0.75rem", textAlign: "center" }}
      >
        <strong>Scan with Arrs Hub Mobile</strong>
        <p className="settings-hint" style={{ marginTop: "0.35rem" }}>
          {hubTokenInQr
            ? "Includes photo dump key + Hub API token."
            : settings?.apiKeySet
              ? "Includes photo dump key (Hub API token missing — open Hub API token settings)."
              : "Generate a photo dump API key to show the QR."}
        </p>
        {qrDataUrl ? (
          <img
            src={qrDataUrl}
            alt="Mobile setup QR — photo key and Hub API token"
            width={240}
            height={240}
            style={{
              background: "#fff",
              borderRadius: 8,
              padding: 8,
              marginTop: "0.5rem",
            }}
          />
        ) : (
          <p className="settings-hint" style={{ marginTop: "0.5rem" }}>
            {settings?.apiKeySet
              ? "Set a valid Hub URL above, then the QR appears here."
              : "No QR yet — generate a photo dump API key first."}
          </p>
        )}
        <div
          className="watchdog-bar-actions"
          style={{ marginTop: "0.75rem", justifyContent: "center" }}
        >
          <button
            type="button"
            className="btn btn-secondary"
            disabled={serverUp === false || busy || !settings?.apiKeySet}
            onClick={() => void refreshSetupQr()}
          >
            Refresh QR
          </button>
        </div>
      </div>

      {plainKey && (
        <div className="sync-alert sync-alert-ok" style={{ marginTop: "0.75rem" }}>
          <strong>New photo dump key</strong> (shown once — also in the QR above):
          <br />
          <code style={{ userSelect: "all", wordBreak: "break-all" }}>
            {plainKey}
          </code>
          <div className="watchdog-bar-actions" style={{ marginTop: "0.75rem" }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void copyKey()}
            >
              Copy key
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setPlainKey(null)}
            >
              Hide key
            </button>
          </div>
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
