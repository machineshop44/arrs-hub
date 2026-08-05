import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectionMode, ServiceConfig } from "../types";
import { getServiceUrl } from "../types";
import { usePlexUpdate } from "../hooks/usePlexUpdate";
import {
  plexInstallBlockedReason,
  shortPlexVersion,
} from "../lib/plexUpdate";

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

export type OmbiPendingItem = {
  id: number;
  type: "movie" | "tv" | "music";
  title: string;
  requester?: string;
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

function ombiHomeUrl(baseUrl: string | undefined): string | null {
  if (!baseUrl) return null;
  return `${baseUrl.replace(/\/+$/, "")}/`;
}

function ombiRequestsUrl(baseUrl: string | undefined): string | null {
  if (!baseUrl) return null;
  return `${baseUrl.replace(/\/+$/, "")}/requests`;
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

function ombiTypeLabel(type: OmbiPendingItem["type"]): string {
  if (type === "tv") return "TV";
  if (type === "music") return "Music";
  return "Movie";
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
  const [ombiOpen, setOmbiOpen] = useState(false);
  const [plexOpen, setPlexOpen] = useState(false);
  const [ombiItems, setOmbiItems] = useState<OmbiPendingItem[]>([]);
  const [ombiLoading, setOmbiLoading] = useState(false);
  const [ombiError, setOmbiError] = useState<string | null>(null);
  const [ombiApprovingId, setOmbiApprovingId] = useState<string | null>(null);
  const queueWrapRef = useRef<HTMLDivElement>(null);
  const ombiWrapRef = useRef<HTMLDivElement>(null);
  const plexWrapRef = useRef<HTMLDivElement>(null);

  const {
    status: plexStatus,
    loading: plexLoading,
    checking: plexChecking,
    busy: plexBusy,
    error: plexError,
    actionMsg: plexActionMsg,
    load: loadPlex,
    startJob: runPlexAction,
    jobBusy: plexJobIsBusy,
  } = usePlexUpdate(serverUp);

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

  const loadOmbiPending = useCallback(async () => {
    if (serverUp === false) return;
    setOmbiLoading(true);
    setOmbiError(null);
    try {
      const res = await fetch("/api/activity/ombi/pending", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: urlMap(services, connectionMode) }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        configured?: boolean;
        items?: OmbiPendingItem[];
        pending?: number;
        error?: string;
      };
      if (!res.ok) throw new Error(json.error || "Failed to load Ombi pending");
      setOmbiItems(Array.isArray(json.items) ? json.items : []);
      const nextPending = json.pending;
      if (typeof nextPending === "number") {
        setSummary((prev) =>
          prev
            ? {
                ...prev,
                ombi: {
                  ok: json.ok !== false,
                  configured: json.configured !== false,
                  pending: nextPending,
                  error: json.error,
                },
              }
            : prev,
        );
      }
    } catch (err) {
      setOmbiError(err instanceof Error ? err.message : String(err));
    } finally {
      setOmbiLoading(false);
    }
  }, [services, connectionMode, serverUp]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 20000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (!ombiOpen) return;
    void loadOmbiPending();
  }, [ombiOpen, loadOmbiPending]);

  useEffect(() => {
    if (!queueOpen && !ombiOpen && !plexOpen) return;
    const onDoc = (event: MouseEvent) => {
      const target = event.target as Node;
      if (queueOpen) {
        const el = queueWrapRef.current;
        if (el && !el.contains(target)) setQueueOpen(false);
      }
      if (ombiOpen) {
        const el = ombiWrapRef.current;
        if (el && !el.contains(target)) setOmbiOpen(false);
      }
      if (plexOpen) {
        const el = plexWrapRef.current;
        if (el && !el.contains(target)) setPlexOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setQueueOpen(false);
        setOmbiOpen(false);
        setPlexOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [queueOpen, ombiOpen, plexOpen]);

  const approveOmbi = async (item: OmbiPendingItem) => {
    const key = `${item.type}-${item.id}`;
    setOmbiApprovingId(key);
    setOmbiError(null);
    try {
      const res = await fetch("/api/activity/ombi/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: item.type,
          id: item.id,
          urls: urlMap(services, connectionMode),
        }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error || "Approve failed");
      await Promise.all([loadOmbiPending(), load()]);
    } catch (err) {
      setOmbiError(err instanceof Error ? err.message : String(err));
    } finally {
      setOmbiApprovingId(null);
    }
  };

  const streams = summary?.streams?.streamCount ?? null;
  const downloads = summary?.downloads?.active ?? null;
  const ombiPending = summary?.ombi?.pending ?? null;
  const queueTotal = summary?.arr?.queueTotal ?? null;
  const pendingSummary = summary == null && serverUp !== false;
  const urls = urlMap(services, connectionMode);
  const ombiOpenUrl = ombiRequestsUrl(urls.ombi) || ombiHomeUrl(urls.ombi);

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
    {
      id: "plex",
      label: "Plex",
      value: (() => {
        if (serverUp === false) return "—";
        if (
          (!plexStatus && (plexLoading || plexChecking)) ||
          plexChecking
        )
          return "…";
        if (!plexStatus) return "—";
        if (plexJobIsBusy) {
          return `${Math.round(plexStatus.job?.progress ?? 0)}%`;
        }
        if (plexStatus.updateAvailable) return "upd";
        if (plexStatus.ok && plexStatus.installedVersion) return "ok";
        if (plexStatus.error && !plexStatus.updateAvailable) return "err";
        return "—";
      })(),
      tone: (() => {
        if (serverUp === false || !plexStatus) return "muted";
        if (plexChecking) return "accent";
        if (plexJobIsBusy || plexStatus.job?.phase === "error") return "warn";
        if (plexStatus.updateAvailable) return "warn";
        if (
          plexStatus.ok &&
          (!plexStatus.error || plexStatus.updateAvailable)
        )
          return "good";
        return "muted";
      })(),
    },
  ];

  const plexCanInstall =
    serverUp !== false &&
    Boolean(plexStatus?.canInstall) &&
    Boolean(plexStatus?.updateAvailable);

  const plexBlocked = plexInstallBlockedReason(plexStatus, serverUp);

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
                  onClick={() => {
                    setOmbiOpen(false);
                    setPlexOpen(false);
                    setQueueOpen((open) => !open);
                  }}
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

          if (chip.id === "ombi") {
            return (
              <div key={chip.id} className="dash-chip-wrap" ref={ombiWrapRef}>
                <button
                  type="button"
                  className={`dash-chip dash-chip-btn tone-${chip.tone}`}
                  aria-expanded={ombiOpen}
                  aria-haspopup="dialog"
                  title="Requests awaiting approval in Ombi — click to review"
                  onClick={() => {
                    setQueueOpen(false);
                    setPlexOpen(false);
                    setOmbiOpen((open) => !open);
                  }}
                >
                  <span className="dash-chip-value">{chip.value}</span>
                  <span className="dash-chip-label">{chip.label}</span>
                </button>
                {ombiOpen && (
                  <div
                    className="dash-chip-popover dash-chip-popover-ombi"
                    role="dialog"
                    aria-label="Ombi pending approvals"
                  >
                    <p className="dash-chip-popover-title">
                      Pending approvals
                      {ombiPending != null ? ` · ${ombiPending}` : ""}
                    </p>

                    {!summary?.ombi?.configured ? (
                      <p className="dash-chip-popover-empty">
                        Add Ombi Home URL + API key in Settings to approve from
                        the hub.
                      </p>
                    ) : ombiLoading && ombiItems.length === 0 ? (
                      <p className="dash-chip-popover-empty">Loading…</p>
                    ) : ombiItems.length === 0 ? (
                      <p className="dash-chip-popover-empty">
                        No requests awaiting approval.
                      </p>
                    ) : (
                      <ul className="dash-queue-issues">
                        {ombiItems.map((item) => {
                          const key = `${item.type}-${item.id}`;
                          const approving = ombiApprovingId === key;
                          return (
                            <li key={key}>
                              <div className="dash-queue-issue-main">
                                <span className="dash-queue-issue-badge">
                                  {ombiTypeLabel(item.type)}
                                  {item.requester
                                    ? ` · ${item.requester}`
                                    : ""}
                                </span>
                                <span className="dash-queue-issue-title">
                                  {item.title}
                                </span>
                              </div>
                              <div className="dash-ombi-actions">
                                <button
                                  type="button"
                                  className="dash-ombi-approve"
                                  disabled={approving || ombiApprovingId != null}
                                  onClick={() => void approveOmbi(item)}
                                >
                                  {approving ? "Approving…" : "Approve"}
                                </button>
                                {ombiOpenUrl ? (
                                  <a
                                    className="dash-queue-issue-link"
                                    href={ombiOpenUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                  >
                                    Open in Ombi
                                  </a>
                                ) : null}
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    )}

                    {ombiError ? (
                      <p className="dash-chip-popover-error">{ombiError}</p>
                    ) : null}

                    {ombiOpenUrl ? (
                      <p className="dash-chip-popover-hint">
                        Fallback:{" "}
                        <a
                          className="dash-queue-issue-link"
                          href={ombiOpenUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={() => setOmbiOpen(false)}
                        >
                          open Ombi requests
                        </a>
                      </p>
                    ) : (
                      <p className="dash-chip-popover-hint">
                        Set Ombi&apos;s Home URL on the dashboard service card
                        to open the web UI.
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          }

          if (chip.id === "plex") {
            return (
              <div key={chip.id} className="dash-chip-wrap" ref={plexWrapRef}>
                <button
                  type="button"
                  className={`dash-chip dash-chip-btn tone-${chip.tone}`}
                  aria-expanded={plexOpen}
                  aria-haspopup="dialog"
                  title={
                    plexStatus?.updateAvailable
                      ? `Plex update: ${shortPlexVersion(plexStatus.installedVersion)} → ${shortPlexVersion(plexStatus.latestVersion)}`
                      : plexStatus?.installedVersion
                        ? `Plex ${shortPlexVersion(plexStatus.installedVersion)} — click for update details`
                        : "Plex Media Server update — click for details"
                  }
                  onClick={() => {
                    setQueueOpen(false);
                    setOmbiOpen(false);
                    setPlexOpen((open) => !open);
                  }}
                >
                  <span className="dash-chip-value">{chip.value}</span>
                  <span className="dash-chip-label">{chip.label}</span>
                </button>
                {plexOpen && (
                  <div
                    className="dash-chip-popover dash-chip-popover-plex"
                    role="dialog"
                    aria-label="Plex Media Server update"
                  >
                    <p className="dash-chip-popover-title">
                      Plex Media Server
                    </p>

                    {serverUp === false ? (
                      <p className="dash-chip-popover-empty">
                        Hub offline — cannot reach Plex update status.
                      </p>
                    ) : plexLoading && !plexStatus && !plexChecking ? (
                      <p className="dash-chip-popover-empty">Loading…</p>
                    ) : (
                      <>
                        <ul className="dash-queue-breakdown dash-plex-versions">
                          <li>
                            <span>Installed</span>
                            <strong>
                              {shortPlexVersion(plexStatus?.installedVersion)}
                            </strong>
                          </li>
                          <li>
                            <span>Latest</span>
                            <strong>
                              {shortPlexVersion(plexStatus?.latestVersion)}
                            </strong>
                          </li>
                          <li>
                            <span>Status</span>
                            <strong>
                              {plexChecking
                                ? "Checking…"
                                : plexStatus?.updateAvailable
                                  ? "Update available"
                                  : plexStatus?.ok
                                    ? "Up to date"
                                    : "Unavailable"}
                            </strong>
                          </li>
                          {plexStatus?.channel ? (
                            <li>
                              <span>Source</span>
                              <strong>{plexStatus.channel}</strong>
                            </li>
                          ) : null}
                          {plexStatus?.lastChecked ? (
                            <li>
                              <span>Checked</span>
                              <strong>
                                {new Date(
                                  plexStatus.lastChecked,
                                ).toLocaleString()}
                              </strong>
                            </li>
                          ) : null}
                        </ul>

                        {plexStatus?.updateAvailable ? (
                          <p className="dash-plex-badge" role="status">
                            Update available
                            {plexStatus.canInstall
                              ? plexStatus.installMethod === "windows-installer"
                                ? " · Windows installer"
                                : ""
                              : " · install blocked"}
                          </p>
                        ) : null}

                        {plexJobIsBusy ||
                        plexStatus?.job?.phase === "done" ||
                        plexStatus?.job?.phase === "error" ? (
                          <div className="dash-plex-job" aria-live="polite">
                            <div className="dash-plex-job-row">
                              <span>{plexStatus?.job?.phase ?? "idle"}</span>
                              <strong>
                                {Math.round(plexStatus?.job?.progress ?? 0)}%
                              </strong>
                            </div>
                            {plexStatus?.job?.message ? (
                              <p className="dash-chip-popover-empty">
                                {plexStatus.job.message}
                              </p>
                            ) : null}
                          </div>
                        ) : null}

                        {plexBlocked && plexStatus?.updateAvailable ? (
                          <p className="dash-chip-popover-empty">
                            {plexBlocked}
                          </p>
                        ) : null}

                        <div className="dash-plex-actions">
                          <button
                            type="button"
                            className="btn btn-ghost"
                            disabled={
                              plexChecking || plexBusy || plexJobIsBusy
                            }
                            aria-busy={plexChecking}
                            onClick={() =>
                              void loadPlex(true, { announce: true })
                            }
                          >
                            {plexChecking ? "Checking…" : "Check"}
                          </button>
                          <button
                            type="button"
                            className="btn btn-primary"
                            disabled={
                              !plexCanInstall ||
                              plexChecking ||
                              plexBusy ||
                              plexJobIsBusy
                            }
                            title={
                              plexBlocked || "Download and apply update now"
                            }
                            onClick={() =>
                              void runPlexAction(
                                {
                                  download: true,
                                  apply: true,
                                  tonight: false,
                                },
                                true,
                              )
                            }
                          >
                            Install
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            disabled={
                              !plexCanInstall ||
                              plexChecking ||
                              plexBusy ||
                              plexJobIsBusy
                            }
                            title={
                              plexBlocked ||
                              "Schedule update for tonight (Butler)"
                            }
                            onClick={() =>
                              void runPlexAction(
                                {
                                  download: true,
                                  apply: true,
                                  tonight: true,
                                },
                                true,
                              )
                            }
                          >
                            Tonight
                          </button>
                        </div>

                        {plexChecking ? (
                          <p
                            className="dash-chip-popover-hint"
                            aria-live="polite"
                          >
                            Checking for updates…
                          </p>
                        ) : null}
                        {plexActionMsg ? (
                          <p
                            className="dash-chip-popover-hint"
                            aria-live="polite"
                          >
                            {plexActionMsg}
                          </p>
                        ) : null}
                        {plexError ? (
                          <p className="dash-chip-popover-error">{plexError}</p>
                        ) : null}
                        <p className="dash-chip-popover-hint">
                          Full controls stay in Settings → Plex Media Server
                          updates. Uses Workouts Plex sign-in.
                        </p>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          }

          return (
            <div
              key={chip.id}
              className={`dash-chip tone-${chip.tone}`}
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
