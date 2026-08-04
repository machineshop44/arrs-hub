import { useCallback, useEffect, useRef, useState } from "react";

export type PlexUpdateStatus = {
  ok?: boolean;
  signedIn?: boolean;
  plexBaseUrl?: string;
  installed?: string | null;
  installedError?: string | null;
  latest?: string | null;
  latestError?: string | null;
  downloadUrl?: string | null;
  updateAvailable?: boolean;
  hint?: string | null;
  download?: {
    phase?: string;
    percent?: number | null;
    bytesReceived?: number;
    bytesTotal?: number | null;
    version?: string | null;
    message?: string | null;
    error?: string | null;
  };
  error?: string;
};

function shortVer(version: string | null | undefined): string {
  if (!version) return "—";
  return version.split("-")[0] || version;
}

interface PlexUpdateCardProps {
  serverUp: boolean | null;
  /** Compact chip-style card for the dashboard */
  compact?: boolean;
}

export function PlexUpdateCard({
  serverUp,
  compact = false,
}: PlexUpdateCardProps) {
  const [status, setStatus] = useState<PlexUpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    type: "ok" | "err";
    text: string;
  } | null>(null);
  const [silent, setSilent] = useState(false);
  const [expanded, setExpanded] = useState(!compact);
  const pollRef = useRef<number | null>(null);

  const load = useCallback(
    async (refresh = false) => {
      if (serverUp === false) return;
      try {
        const qs = refresh ? "?refresh=1" : "";
        const res = await fetch(`/api/plex/update-status${qs}`);
        const json = (await res.json()) as PlexUpdateStatus;
        if (!res.ok) throw new Error(json.error || "Status failed");
        setStatus(json);
        if (!refresh) setMessage(null);
      } catch (err) {
        setMessage({
          type: "err",
          text: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [serverUp],
  );

  useEffect(() => {
    void load(false);
    const timer = window.setInterval(() => void load(false), 60000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    const phase = status?.download?.phase;
    const shouldPoll =
      phase === "downloading" || phase === "installing" || busy;
    if (!shouldPoll) {
      if (pollRef.current != null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    if (pollRef.current != null) return;
    pollRef.current = window.setInterval(() => void load(false), 800);
    return () => {
      if (pollRef.current != null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [status?.download?.phase, busy, load]);

  const runAction = async (
    path: string,
    body: Record<string, unknown> = {},
    okText?: string,
  ) => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as {
        error?: string;
        download?: PlexUpdateStatus["download"];
      };
      if (!res.ok) throw new Error(json.error || "Request failed");
      await load(false);
      if (okText) setMessage({ type: "ok", text: okText });
    } catch (err) {
      setMessage({
        type: "err",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
      await load(false);
    }
  };

  const installed = shortVer(status?.installed);
  const latest = shortVer(status?.latest);
  const updateAvailable = Boolean(status?.updateAvailable);
  const downloading = status?.download?.phase === "downloading";
  const percent = status?.download?.percent;
  const setupNeeded = !status?.signedIn || Boolean(status?.installedError);

  let summaryLabel = "Plex Server";
  let summaryValue = "—";
  let tone: "good" | "warn" | "muted" | "accent" | "bad" = "muted";

  if (serverUp === false) {
    summaryValue = "hub offline";
  } else if (!status) {
    summaryValue = "…";
  } else if (!status.signedIn) {
    summaryValue = "sign in";
    tone = "warn";
  } else if (status.installedError) {
    summaryValue = "unreachable";
    tone = "bad";
  } else if (updateAvailable) {
    summaryValue = `${installed} → ${latest}`;
    tone = "warn";
  } else if (status.installed && status.latest) {
    summaryValue = "up to date";
    tone = "good";
  } else if (status.latestError) {
    summaryValue = "check failed";
    tone = "warn";
  }

  const headline = updateAvailable
    ? `Update available: ${installed} → ${latest}`
    : status?.installed && status?.latest && !status.installedError
      ? `Plex Server: up to date (${installed})`
      : "Plex Media Server updates";

  const body = (
    <>
      <p className="settings-hint plex-update-copy">
        Uses your Workouts Plex sign-in and base URL. Arrs Hub downloads the
        official Windows installer and launches it — Windows may prompt for UAC.
        Arrs Hub cannot silently finish Plex&apos;s own wizard without their
        installer flags.
      </p>

      {setupNeeded && status?.hint ? (
        <p className="settings-hint plex-update-hint">{status.hint}</p>
      ) : null}

      <div className="plex-update-meta">
        <div>
          <span>Installed</span>
          <strong>{installed}</strong>
        </div>
        <div>
          <span>Latest</span>
          <strong>{latest}</strong>
        </div>
        <div>
          <span>Server</span>
          <strong>{status?.plexBaseUrl || "—"}</strong>
        </div>
      </div>

      {(downloading || status?.download?.message) && (
        <div className="plex-update-progress" role="status" aria-live="polite">
          {downloading && percent != null ? (
            <div className="stream-progress-bar" aria-hidden="true">
              <div
                className="stream-progress-fill"
                style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
              />
            </div>
          ) : null}
          <p className="plex-update-progress-text">
            {status?.download?.message ||
              (downloading ? "Downloading…" : null)}
          </p>
        </div>
      )}

      {message ? (
        <div
          className={`sync-alert ${message.type === "ok" ? "sync-alert-ok" : "sync-alert-err"}`}
        >
          {message.text}
        </div>
      ) : null}

      {status?.latestError && !status.latest ? (
        <div className="sync-alert sync-alert-err">{status.latestError}</div>
      ) : null}

      <div className="watchdog-bar-actions plex-update-actions">
        <button
          type="button"
          className="btn btn-ghost"
          disabled={serverUp === false || busy}
          onClick={() => void load(true)}
        >
          Check now
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={serverUp === false || busy || !status?.downloadUrl}
          onClick={() =>
            void runAction("/api/plex/update/download", {}, "Download started.")
          }
        >
          {downloading
            ? percent != null
              ? `Downloading ${percent}%`
              : "Downloading…"
            : "Download"}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={serverUp === false || busy || !status?.downloadUrl}
          onClick={() =>
            void runAction(
              "/api/plex/update/download-and-install",
              { silent },
              "Installer launched. Complete Plex’s wizard if it appears.",
            )
          }
        >
          {updateAvailable ? "Download & install" : "Install latest"}
        </button>
      </div>

      <label className="toggle plex-update-silent">
        <input
          type="checkbox"
          checked={silent}
          disabled={busy}
          onChange={(e) => setSilent(e.target.checked)}
        />
        <span className="toggle-label">
          Advanced: silent install (<code>/quiet</code>) — still may show UAC;
          default is interactive
        </span>
      </label>
    </>
  );

  if (compact) {
    return (
      <div className={`plex-update-card plex-update-compact tone-${tone}`}>
        <button
          type="button"
          className="plex-update-summary"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          <span className="plex-update-summary-label">{summaryLabel}</span>
          <span className="plex-update-summary-value">{summaryValue}</span>
          <span className="plex-update-chevron" aria-hidden="true">
            {expanded ? "▾" : "▸"}
          </span>
        </button>
        {expanded ? <div className="plex-update-body">{body}</div> : null}
      </div>
    );
  }

  return (
    <section className="settings-group plex-update-card">
      <h3>{headline}</h3>
      {body}
    </section>
  );
}
