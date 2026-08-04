import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectionMode, ServiceConfig } from "../types";
import { getServiceUrl } from "../types";

export type ArrQueueIssue = {
  id?: number | null;
  title: string;
  status?: string;
  trackedDownloadStatus?: string;
  trackedDownloadState?: string;
  errorMessage?: string;
  outputPath?: string;
};

export type ArrQueueApp = {
  ok: boolean;
  configured?: boolean;
  total: number;
  downloading?: number;
  issues?: ArrQueueIssue[];
  error?: string;
};

export type HubStatusSummary = {
  ok: boolean;
  checkedAt?: string;
  streams?: {
    ok: boolean;
    configured: boolean;
    streamCount: number;
    error?: string;
  };
  downloads?: {
    active: number;
    qbittorrent?: { ok: boolean; configured: boolean; active: number };
    sabnzbd?: { ok: boolean; configured: boolean; active: number };
  };
  ombi?: {
    ok: boolean;
    configured: boolean;
    pending: number;
    error?: string;
  };
  arr?: {
    queueTotal: number;
    sonarr?: ArrQueueApp;
    radarr?: ArrQueueApp;
    lidarr?: ArrQueueApp;
  };
};

interface DashboardStatusProps {
  services: ServiceConfig[];
  connectionMode: ConnectionMode;
  upCount: number;
  downCount: number;
  serverUp: boolean | null;
  scanning?: boolean;
  onOpenStreams?: () => void;
}

function urlMap(
  services: ServiceConfig[],
  mode: ConnectionMode,
): Record<string, string> {
  const ids = [
    "sonarr",
    "radarr",
    "lidarr",
    "qbittorrent",
    "sabnzbd",
    "ombi",
    "tautulli",
  ];
  const out: Record<string, string> = {};
  for (const id of ids) {
    const service = services.find((s) => s.id === id && s.enabled);
    if (!service) continue;
    const url = getServiceUrl(service, mode);
    if (url) out[id] = url;
  }
  return out;
}

function activityQueueUrl(baseUrl: string | undefined): string | null {
  if (!baseUrl) return null;
  return `${baseUrl.replace(/\/+$/, "")}/activity/queue`;
}

function issueBadge(issue: ArrQueueIssue): string {
  const state = String(issue.trackedDownloadState || "").toLowerCase();
  const tracked = String(issue.trackedDownloadStatus || "").toLowerCase();
  if (state === "importpending") return "Manual import";
  if (state === "failed" || state === "failedpending") return "Failed";
  if (tracked === "warning") return "Warning";
  if (tracked === "error") return "Error";
  return issue.status || "Stuck";
}

export function DashboardStatus({
  services,
  connectionMode,
  upCount,
  downCount,
  serverUp,
  scanning = false,
  onOpenStreams,
}: DashboardStatusProps) {
  const [summary, setSummary] = useState<HubStatusSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const queueWrapRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (serverUp === false) return;
    try {
      const res = await fetch("/api/status/summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: urlMap(services, connectionMode) }),
      });
      const json = (await res.json()) as HubStatusSummary & { error?: string };
      if (!res.ok) throw new Error(json.error || "Status failed");
      setSummary(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [services, connectionMode, serverUp]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 20000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (!queueOpen) return;
    const onDoc = (event: MouseEvent) => {
      const el = queueWrapRef.current;
      if (el && !el.contains(event.target as Node)) {
        setQueueOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setQueueOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [queueOpen]);

  const streams = summary?.streams?.streamCount ?? null;
  const downloads = summary?.downloads?.active ?? null;
  const ombiPending = summary?.ombi?.pending ?? null;
  const queueTotal = summary?.arr?.queueTotal ?? null;
  const pendingSummary = summary == null && serverUp !== false;
  const urls = urlMap(services, connectionMode);

  const arrApps: {
    id: "sonarr" | "radarr" | "lidarr";
    label: string;
    data?: ArrQueueApp;
  }[] = [
    { id: "sonarr", label: "Sonarr", data: summary?.arr?.sonarr },
    { id: "radarr", label: "Radarr", data: summary?.arr?.radarr },
    { id: "lidarr", label: "Lidarr", data: summary?.arr?.lidarr },
  ];

  const problemItems = arrApps.flatMap((app) =>
    (app.data?.issues ?? []).map((issue) => ({
      appId: app.id,
      appLabel: app.label,
      issue,
      openUrl: activityQueueUrl(urls[app.id]),
    })),
  );

  const chips = [
    {
      id: "up",
      label: "Apps up",
      value: scanning ? "…" : String(upCount),
      tone: scanning ? "muted" : upCount > 0 ? "good" : "muted",
    },
    {
      id: "down",
      label: "Apps down",
      value: scanning ? "…" : String(downCount),
      tone: scanning ? "muted" : downCount > 0 ? "bad" : "good",
    },
    {
      id: "streams",
      label: "Streams",
      value:
        pendingSummary || streams == null
          ? "—"
          : summary?.streams?.configured
            ? String(streams)
            : "setup",
      tone:
        streams && streams > 0
          ? "accent"
          : summary?.streams?.configured
            ? "muted"
            : "warn",
    },
    {
      id: "downloads",
      label: "Downloads",
      value:
        pendingSummary || downloads == null
          ? "—"
          : summary?.downloads?.qbittorrent?.configured ||
              summary?.downloads?.sabnzbd?.configured
            ? String(downloads)
            : "setup",
      tone: downloads && downloads > 0 ? "accent" : "muted",
    },
    {
      id: "queue",
      label: "*arr queue",
      value:
        pendingSummary || queueTotal == null
          ? "—"
          : summary?.arr?.sonarr?.ok || summary?.arr?.radarr?.ok
            ? String(queueTotal)
            : "setup",
      tone: queueTotal && queueTotal > 0 ? "warn" : "muted",
    },
    {
      id: "ombi",
      label: "Ombi pending",
      value:
        pendingSummary || ombiPending == null
          ? "—"
          : summary?.ombi?.configured
            ? String(ombiPending)
            : "setup",
      tone:
        ombiPending && ombiPending > 0
          ? "warn"
          : summary?.ombi?.configured
            ? "good"
            : "muted",
    },
  ];

  return (
    <section className="dash-status" aria-label="Hub status summary">
      {(scanning || pendingSummary) && serverUp !== false && (
        <p className="port-scan-banner" role="status" aria-live="polite">
          <span className="port-scan-spinner" aria-hidden="true" />
          {scanning ? "Searching ports…" : "Checking services…"}
        </p>
      )}
      <div className="dash-chips">
        {chips.map((chip) => {
          if (chip.id === "streams" && onOpenStreams) {
            return (
              <button
                key={chip.id}
                type="button"
                className={`dash-chip dash-chip-btn tone-${chip.tone}`}
                title={
                  summary?.streams?.configured
                    ? "Open Streams — live Plex streams from Tautulli"
                    : "Open Streams"
                }
                onClick={onOpenStreams}
              >
                <span className="dash-chip-value">{chip.value}</span>
                <span className="dash-chip-label">{chip.label}</span>
              </button>
            );
          }

          if (chip.id === "queue") {
            return (
              <div
                key={chip.id}
                className="dash-chip-wrap"
                ref={queueWrapRef}
              >
                <button
                  type="button"
                  className={`dash-chip dash-chip-btn tone-${chip.tone}`}
                  aria-expanded={queueOpen}
                  aria-haspopup="dialog"
                  title="Sonarr + Radarr (+ Lidarr) queue total — click for breakdown"
                  onClick={() => setQueueOpen((open) => !open)}
                >
                  <span className="dash-chip-value">{chip.value}</span>
                  <span className="dash-chip-label">{chip.label}</span>
                </button>
                {queueOpen && (
                  <div
                    className="dash-chip-popover"
                    role="dialog"
                    aria-label="*arr queue breakdown"
                  >
                    <p className="dash-chip-popover-title">
                      Queue by app
                      {queueTotal != null ? ` · ${queueTotal} total` : ""}
                    </p>
                    <ul className="dash-queue-breakdown">
                      {arrApps.map((app) => {
                        const configured =
                          app.data?.ok ||
                          app.data?.configured ||
                          Boolean(urls[app.id]);
                        const value = !configured
                          ? "—"
                          : app.data?.ok
                            ? String(app.data.total ?? 0)
                            : app.data?.error
                              ? "err"
                              : "—";
                        return (
                          <li key={app.id}>
                            <span>{app.label}</span>
                            <strong>{value}</strong>
                          </li>
                        );
                      })}
                    </ul>

                    <p className="dash-chip-popover-title">Needs attention</p>
                    {problemItems.length === 0 ? (
                      <p className="dash-chip-popover-empty">
                        No stuck / manual-import items in the first queue page.
                      </p>
                    ) : (
                      <ul className="dash-queue-issues">
                        {problemItems.map(({ appId, appLabel, issue, openUrl }) => (
                          <li key={`${appId}-${issue.id ?? issue.title}`}>
                            <div className="dash-queue-issue-main">
                              <span className="dash-queue-issue-badge">
                                {appLabel} · {issueBadge(issue)}
                              </span>
                              <span className="dash-queue-issue-title">
                                {issue.title}
                              </span>
                              {issue.errorMessage ? (
                                <span className="dash-queue-issue-msg">
                                  {issue.errorMessage}
                                </span>
                              ) : null}
                              {issue.outputPath ? (
                                <span className="dash-queue-issue-path">
                                  {issue.outputPath}
                                </span>
                              ) : null}
                            </div>
                            {openUrl ? (
                              <a
                                className="dash-queue-issue-link"
                                href={openUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={() => setQueueOpen(false)}
                              >
                                Open in {appLabel}
                              </a>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                    {/* TODO: interactive Manual Import from hub (fetch /api/v3/manualimport
                        candidates, pick episode/movie, confirm) — deferred beyond this release. */}
                    <p className="dash-chip-popover-hint">
                      Matching still happens in Sonarr/Radarr Activity. Hub links
                      open the queue; in-hub Manual Import is planned later.
                    </p>
                  </div>
                )}
              </div>
            );
          }

          return (
            <div
              key={chip.id}
              className={`dash-chip tone-${chip.tone}`}
              title={
                chip.id === "ombi"
                  ? "Requests awaiting approval in Ombi"
                  : undefined
              }
            >
              <span className="dash-chip-value">{chip.value}</span>
              <span className="dash-chip-label">{chip.label}</span>
            </div>
          );
        })}
      </div>

      {error && serverUp !== false && (
        <p className="dash-status-hint">Status refresh: {error}</p>
      )}
      {serverUp === false && (
        <p className="dash-status-hint">
          Hub API offline — start the server for live streams / queue / downloads.
        </p>
      )}
    </section>
  );
}
