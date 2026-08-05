import {
  plexInstallBlockedReason,
  plexJobBusy,
  shortPlexVersion,
} from "../lib/plexUpdate";
import { usePlexUpdate } from "../hooks/usePlexUpdate";

export type { PlexUpdateStatus } from "../lib/plexUpdate";

interface PlexUpdateCardProps {
  serverUp: boolean | null;
}

export function PlexUpdateCard({ serverUp }: PlexUpdateCardProps) {
  const {
    status,
    busy,
    checking,
    error,
    actionMsg,
    load,
    startJob,
    jobBusy,
  } = usePlexUpdate(serverUp);

  const installed = shortPlexVersion(status?.installedVersion);
  const latest = shortPlexVersion(status?.latestVersion);
  const updateAvailable = Boolean(status?.updateAvailable);
  const canInstall = Boolean(status?.canInstall);
  const phase = status?.job?.phase;
  const progress = status?.job?.progress ?? 0;
  const blocked = plexInstallBlockedReason(status, serverUp);

  const headline = updateAvailable
    ? `Update available: ${installed} → ${latest}`
    : status?.installedVersion && !status.error
      ? `Plex Server: up to date (${installed})`
      : "Plex Media Server updates";

  const installDisabled =
    serverUp === false ||
    busy ||
    jobBusy ||
    checking ||
    !canInstall ||
    !updateAvailable;

  return (
    <section className="settings-group plex-update-card">
      <h3>{headline}</h3>
      <p className="settings-hint plex-update-copy">
        Uses your Workouts Plex sign-in. The hub talks to PMS{" "}
        <code>/updater/*</code> on this PC — install only works when{" "}
        <code>canInstall</code> is true (Windows PMS). When{" "}
        <code>/updater/status</code> is empty, latest comes from plex.tv
        downloads JSON (Install stays disabled until PMS lists the Release).
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
          <span>Source</span>
          <strong>{status?.channel || "—"}</strong>
        </div>
        <div>
          <span>canInstall</span>
          <strong>{canInstall ? "yes" : "no"}</strong>
        </div>
      </div>

      {(jobBusy || phase === "done" || phase === "error") && (
        <div className="plex-update-progress" role="status" aria-live="polite">
          {jobBusy ? (
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

      {actionMsg ? (
        <div className="sync-alert sync-alert-ok">{actionMsg}</div>
      ) : null}

      {error ? <div className="sync-alert sync-alert-err">{error}</div> : null}

      {!canInstall && status?.updateAvailable ? (
        <p className="settings-hint plex-update-hint">
          {status.channel === "plex.tv"
            ? "Seen on plex.tv, but PMS updater has not listed this Release yet — update from Plex Settings on the host (Install via hub unavailable until PMS lists it)."
            : "PMS reports canInstall=false — update on the host (manual/NAS installs cannot be applied from Arrs Hub)."}
        </p>
      ) : !canInstall && status?.installedVersion ? (
        <p className="settings-hint plex-update-hint">{blocked}</p>
      ) : null}

      <div className="watchdog-bar-actions plex-update-actions">
        <button
          type="button"
          className="btn btn-ghost"
          disabled={serverUp === false || busy || jobBusy || checking}
          onClick={() => void load(true, { announce: true })}
        >
          {checking ? "Checking…" : "Check now"}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={installDisabled}
          title={blocked || "Download and apply update now"}
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
          title={blocked || "Schedule update for tonight (Butler)"}
          onClick={() =>
            void startJob({ download: true, apply: true, tonight: true }, true)
          }
        >
          Tonight
        </button>
      </div>
    </section>
  );
}
