import { useCallback, useEffect, useRef, useState } from "react";

type JobPhase =
  | "idle"
  | "checking"
  | "downloading"
  | "applying"
  | "done"
  | "error";

export type PlexUpdateStatus = {
  ok?: boolean;
  installedVersion?: string | null;
  latestVersion?: string | null;
  updateAvailable?: boolean;
  canInstall?: boolean;
  channel?: string | null;
  releaseState?: string | null;
  lastChecked?: string | null;
  error?: string | null;
  job?: {
    id?: string | null;
    phase?: JobPhase;
    progress?: number;
    message?: string;
    error?: string | null;
  };
};

function shortVer(version: string | null | undefined): string {
  if (!version) return "—";
  return version.split("-")[0] || version;
}

function jobBusy(phase?: string | null): boolean {
  return (
    phase === "checking" ||
    phase === "downloading" ||
    phase === "applying"
  );
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
    const phase = status?.job?.phase;
    const shouldPoll = jobBusy(phase) || busy;
    if (!shouldPoll) {
      if (pollRef.current != null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    if (pollRef.current != null) return;
    pollRef.current = window.setInterval(() => {
      void (async () => {
        try {
          const res = await fetch("/api/plex/update-job");
          const json = (await res.json()) as {
            ok?: boolean;
            job?: PlexUpdateStatus["job"];
            error?: string;
          };
          if (!res.ok) throw new Error(json.error || "Job poll failed");
          setStatus((prev) => (prev ? { ...prev, job: json.job } : prev));
          if (!jobBusy(json.job?.phase)) {
            setBusy(false);
            await load(false);
            if (json.job?.phase === "error") {
              setMessage({
                type: "err",
                text: json.job.error || json.job.message || "Update failed",
              });
            } else if (json.job?.message) {
              setMessage({ type: "ok", text: json.job.message });
            }
          }
        } catch (err) {
          setBusy(false);
          setMessage({
            type: "err",
            text: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    }, 1200);
    return () => {
      if (pollRef.current != null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [status?.job?.phase, busy, load]);

  const startJob = async (
    body: { download?: boolean; apply?: boolean; tonight?: boolean },
    confirmApply: boolean,
  ) => {
    if (confirmApply) {
      const tonight = Boolean(body.tonight);
      const ok = window.confirm(
        tonight
          ? "Schedule Plex Media Server update for tonight (Butler)? Streams may still drop when it applies."
          : "Apply Plex Media Server update now? PMS will restart and active streams will disconnect.",
      );
      if (!ok) return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/plex/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        job?: PlexUpdateStatus["job"];
        error?: string;
      };
      if (!res.ok) throw new Error(json.error || "Request failed");
      setStatus((prev) => (prev ? { ...prev, job: json.job } : prev));
      if (!jobBusy(json.job?.phase)) {
        setBusy(false);
        setMessage({
          type: "ok",
          text: json.job?.message || "Done.",
        });
        await load(false);
      }
    } catch (err) {
      setBusy(false);
      setMessage({
        type: "err",
        text: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const installed = shortVer(status?.installedVersion);
  const latest = shortVer(status?.latestVersion);
  const updateAvailable = Boolean(status?.updateAvailable);
  const canInstall = Boolean(status?.canInstall);
  const phase = status?.job?.phase;
  const progress = status?.job?.progress ?? 0;

  let summaryLabel = "Plex Server";
  let summaryValue = "—";
  let tone: "good" | "warn" | "muted" | "accent" | "bad" = "muted";

  if (serverUp === false) {
    summaryValue = "hub offline";
  } else if (!status) {
    summaryValue = "…";
  } else if (jobBusy(phase)) {
    summaryValue = `${Math.round(progress)}%`;
    tone = "warn";
  } else if (status.error && !status.installedVersion) {
    summaryValue = "unreachable";
    tone = "bad";
  } else if (updateAvailable) {
    summaryValue = `${installed} → ${latest}`;
    tone = "warn";
  } else if (status.installedVersion) {
    summaryValue = "up to date";
    tone = "good";
  }

  const headline = updateAvailable
    ? `Update available: ${installed} → ${latest}`
    : status?.installedVersion && !status.error
      ? `Plex Server: up to date (${installed})`
      : "Plex Media Server updates";

  const installDisabled =
    serverUp === false || busy || jobBusy(phase) || !canInstall || !updateAvailable;

  const body = (
    <>
      <p className="settings-hint plex-update-copy">
        Uses your Workouts Plex sign-in. The hub talks to PMS{" "}
        <code>/updater/*</code> on this PC — install only works when{" "}
        <code>canInstall</code> is true (Windows PMS).
      </p>

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
          <span>canInstall</span>
          <strong>{canInstall ? "yes" : "no"}</strong>
        </div>
      </div>

      {(jobBusy(phase) || phase === "done" || phase === "error") && (
        <div className="plex-update-progress" role="status" aria-live="polite">
          {jobBusy(phase) ? (
            <div className="stream-progress-bar" aria-hidden="true">
              <div
                className="stream-progress-fill"
                style={{
                  width: `${Math.max(0, Math.min(100, progress))}%`,
                }}
              />
            </div>
          ) : null}
          <p className="plex-update-progress-text">
            {status?.job?.message || phase}
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

      {status?.error ? (
        <div className="sync-alert sync-alert-err">{status.error}</div>
      ) : null}

      {!canInstall && status?.updateAvailable ? (
        <p className="settings-hint plex-update-hint">
          {status.channel === "plex.tv"
            ? "Seen on plex.tv, but PMS updater has not listed this Release yet — update from Plex Settings on the host (Install via hub unavailable until PMS lists it)."
            : "PMS reports canInstall=false — update on the host (manual/NAS installs cannot be applied from Arrs Hub)."}
        </p>
      ) : !canInstall && status?.installedVersion ? (
        <p className="settings-hint plex-update-hint">
          PMS reports canInstall=false — update on the host (manual/NAS installs
          cannot be applied from Arrs Hub).
        </p>
      ) : null}

      <div className="watchdog-bar-actions plex-update-actions">
        <button
          type="button"
          className="btn btn-ghost"
          disabled={serverUp === false || busy || jobBusy(phase)}
          onClick={() => void load(true)}
        >
          Check now
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={installDisabled}
          onClick={() =>
            void startJob(
              { download: true, apply: true, tonight: false },
              true,
            )
          }
        >
          Install now
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={installDisabled}
          onClick={() =>
            void startJob({ download: true, apply: true, tonight: true }, true)
          }
        >
          Tonight
        </button>
      </div>
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
