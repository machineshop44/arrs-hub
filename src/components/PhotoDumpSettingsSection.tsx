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
  // N:\… or \\server\share\…
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
      if (typeof json.lanUrl === "string" && json.lanUrl) {
        setPairUrl((prev) => prev || json.lanUrl);
      }
    } catch {
      // ignore — user can type URL
    }
  }, [serverUp]);

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
          width: 220,
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

  const rebuildPairPayload = (key: string, url: string) => {
    const base = url.trim().replace(/\/+$/, "");
    const k = key.trim();
    if (!base || !k || !looksHttpUrl(base)) {
      setPairPayload(null);
      return;
    }
    const params = new URLSearchParams();
    params.set("url", base);
    params.set("key", k);
    setPairPayload(`arrs-hub-photo-dump://v1?${params.toString()}`);
  };

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
      if (typeof json.pairHint?.lanUrl === "string" && !pairUrl.trim()) {
        setPairUrl(json.pairHint.lanUrl);
      }
      if (typeof json.apiKeyPlain === "string" && json.apiKeyPlain) {
        setPlainKey(json.apiKeyPlain);
        if (typeof json.pairPayload === "string" && json.pairPayload) {
          setPairPayload(json.pairPayload);
        } else {
          rebuildPairPayload(
            json.apiKeyPlain,
            pairUrl || json.pairHint?.lanUrl || "",
          );
        }
      }
      setMessage({
        type: "ok",
        text: opts?.rotateKey
          ? "New photo dump API key generated — scan the QR in Arrs Hub Mobile (or copy the key)."
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

  const clearShownKey = () => {
    setPlainKey(null);
    setPairPayload(null);
    setQrDataUrl(null);
  };

  return (
    <section className="settings-group" id="photo-dump">
      <h3>Photo dump</h3>
      <p className="settings-hint">
        Receive photos/videos from Arrs Hub Mobile into a folder on this PC
        (e.g. <code>N:\PhoneDump</code>). Mobile can browse and create folders
        under this root only. Requires a port-forwarded Hub (same as Mobile
        status / WOL) and the API key below. Settings can only be saved from
        this PC.
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
          placeholder="http://192.168.x.x:3000"
          onChange={(e) => {
            const next = e.target.value;
            setPairUrl(next);
            if (plainKey) rebuildPairPayload(plainKey, next);
          }}
        />
      </label>
      <p className="settings-hint">
        Use the LAN URL at home, or your public IP / DDNS (with port forward) when
        away — same host Mobile uses for Hub status.
      </p>

      <p className="settings-hint">
        API key{" "}
        {settings?.apiKeySet
          ? "(saved — generate a new one if needed)"
          : "(not set yet)"}
        {settings?.apiKey ? `: ${settings.apiKey}` : ""}
      </p>

      {plainKey && (
        <div className="sync-alert sync-alert-ok">
          <strong>Scan or copy into Mobile now</strong> — the plain key is only
          shown once:
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
              onClick={clearShownKey}
            >
              Hide key
            </button>
          </div>
          {qrDataUrl ? (
            <div style={{ marginTop: "0.85rem", textAlign: "center" }}>
              <img
                src={qrDataUrl}
                alt="Photo dump setup QR code"
                width={220}
                height={220}
                style={{
                  background: "#fff",
                  borderRadius: 8,
                  padding: 8,
                }}
              />
              <p className="settings-hint" style={{ marginTop: "0.5rem" }}>
                Mobile: Photo Dump → Scan setup QR
              </p>
            </div>
          ) : (
            <p className="settings-hint" style={{ marginTop: "0.5rem" }}>
              Set a Hub URL above to show the setup QR.
            </p>
          )}
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
