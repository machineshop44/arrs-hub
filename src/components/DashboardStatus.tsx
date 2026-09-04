import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConnectionMode, ServiceConfig } from "../types";
import { getServiceUrl } from "../types";
import type {
  PcHealth,
  PcWatchSummary,
  ServiceHealth,
  WatchServiceSummary,
} from "../hooks/useServiceHealth";
import {
  buildCompanionPcStatus,
  companionAppHealthLabel,
  companionChipMeta,
} from "../lib/companionStatus";
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
  pcConfigs?: PcWatchSummary[];
  pcs?: Record<string, PcHealth>;
  serviceHealth?: Record<string, ServiceHealth>;
  watchServices?: Record<string, WatchServiceSummary>;
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
    "readarr",
    "prowlarr",
    "bazarr",
    "whisparr",
    "qbittorrent",
    "sabnzbd",
    "ombi",
    "tautulli",
    "fileflows",
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

const CLICK_UPDATE_APP_IDS = new Set([
  "sonarr",
  "radarr",
  "lidarr",
  "readarr",
  "prowlarr",
  "whisparr",
  "tautulli",
  "qbittorrent",
  "sabnzbd",
]);

const COMPANION_CLICK_UPDATE_IDS = new Set(["qbittorrent", "sabnzbd"]);

type AppUpdateJobState = {
  id: string | null;
  appId: string | null;
  phase: "idle" | "running" | "done" | "error";
  message: string;
  error?: string | null;
};

function activityQueueUrl(baseUrl: string | undefined): string | null {
  if (!baseUrl) return null;
  return `${baseUrl.replace(/\/+$/, "")}/activity/queue`;
}

function serviceHomeUrl(baseUrl: string | undefined): string | null {
  if (!baseUrl) return null;
  return `${baseUrl.replace(/\/+$/, "")}/`;
}

function ombiHomeUrl(baseUrl: string | undefined): string | null {
  return serviceHomeUrl(baseUrl);
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

type ChipVersionApp = {
  id: string;
  label: string;
  version: string | null;
  updateAvailable?: boolean;
  latestVersion?: string | null;
  openUrl?: string | null;
  configured?: boolean;
  ok?: boolean;
  error?: string;
};

type ChipVersionsPayload = {
  hub?: { version?: string | null; arrUpdateCount?: number };
  arrs?: ChipVersionApp[];
  companion?: {
    name?: string;
    version?: string | null;
    appUpdateCount?: number;
    apps?: ChipVersionApp[];
  } | null;
};

function ChipProductVersion({ version }: { version?: string | null }) {
  if (!version) return null;
  return <span className="dash-chip-meta">v{version}</span>;
}

export function DashboardStatus({
  services,
  connectionMode,
  upCount,
  downCount,
  serverUp,
  scanning = false,
  pcConfigs = [],
  pcs = {},
  serviceHealth = {},
  watchServices = {},
  onOpenStreams,
}: DashboardStatusProps) {
  const [summary, setSummary] = useState<HubStatusSummary | null>(null);
  const [chipVersions, setChipVersions] = useState<ChipVersionsPayload | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [hubOpen, setHubOpen] = useState(false);
  const [companionOpen, setCompanionOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const [ombiOpen, setOmbiOpen] = useState(false);
  const [plexOpen, setPlexOpen] = useState(false);
  const [ombiItems, setOmbiItems] = useState<OmbiPendingItem[]>([]);
  const [ombiLoading, setOmbiLoading] = useState(false);
  const [ombiError, setOmbiError] = useState<string | null>(null);
  const [ombiSuccess, setOmbiSuccess] = useState<string | null>(null);
  const [ombiApprovingId, setOmbiApprovingId] = useState<string | null>(null);
  const [hubInfo, setHubInfo] = useState<{
    version?: string;
    bind?: string;
    port?: number;
    lanReachable?: boolean;
  } | null>(null);
  const [appUpdateJobs, setAppUpdateJobs] = useState<
    Record<string, AppUpdateJobState>
  >({});
  const [appUpdateNotice, setAppUpdateNotice] = useState<string | null>(null);
  const hubWrapRef = useRef<HTMLDivElement>(null);
  const companionWrapRef = useRef<HTMLDivElement>(null);
  const queueWrapRef = useRef<HTMLDivElement>(null);
  const downloadsWrapRef = useRef<HTMLDivElement>(null);
  const ombiWrapRef = useRef<HTMLDivElement>(null);
  const plexWrapRef = useRef<HTMLDivElement>(null);

  const closeAllPopovers = useCallback(() => {
    setHubOpen(false);
    setCompanionOpen(false);
    setQueueOpen(false);
    setDownloadsOpen(false);
    setOmbiOpen(false);
    setPlexOpen(false);
  }, []);

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
    if (serverUp === false) {
      setSummary(null);
      setChipVersions(null);
      setError(null);
      return;
    }
    try {
      const urls = urlMap(services, connectionMode);
      const [summaryRes, versionsRes] = await Promise.all([
        fetch("/api/status/summary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ urls }),
        }),
        fetch("/api/status/chip-versions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ urls }),
        }),
      ]);
      const json = (await summaryRes.json()) as HubStatusSummary & {
        error?: string;
      };
      if (!summaryRes.ok) throw new Error(json.error || "Status failed");
      setSummary(json);
      if (versionsRes.ok) {
        setChipVersions((await versionsRes.json()) as ChipVersionsPayload);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [services, connectionMode, serverUp]);

  const startStackAppUpdate = useCallback(
    async (appId: string, pcId?: string) => {
      if (!CLICK_UPDATE_APP_IDS.has(appId)) return;
      const urls = urlMap(services, connectionMode);
      setAppUpdateNotice(null);
      setAppUpdateJobs((prev) => ({
        ...prev,
        [appId]: {
          id: null,
          appId,
          phase: "running",
          message: "Starting update…",
          error: null,
        },
      }));
      try {
        const res = await fetch("/api/status/app-update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: appId,
            urls,
            baseUrl: urls[appId] || undefined,
            pcId: pcId || undefined,
          }),
        });
        const json = (await res.json()) as {
          ok?: boolean;
          error?: string;
          job?: AppUpdateJobState;
        };
        if (!res.ok) {
          throw new Error(json.error || "Update failed to start");
        }
        if (json.job) {
          setAppUpdateJobs((prev) => ({ ...prev, [appId]: json.job! }));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setAppUpdateJobs((prev) => ({
          ...prev,
          [appId]: {
            id: null,
            appId,
            phase: "error",
            message,
            error: message,
          },
        }));
        setAppUpdateNotice(message);
      }
    },
    [services, connectionMode],
  );

  useEffect(() => {
    const runningIds = Object.entries(appUpdateJobs)
      .filter(([, job]) => job.phase === "running")
      .map(([id]) => id);
    if (runningIds.length === 0) return;

    let cancelled = false;
    const poll = async () => {
      for (const appId of runningIds) {
        try {
          const res = await fetch(
            `/api/status/app-update?id=${encodeURIComponent(appId)}`,
          );
          const json = (await res.json()) as { job?: AppUpdateJobState };
          if (cancelled || !json.job) continue;
          setAppUpdateJobs((prev) => ({ ...prev, [appId]: json.job! }));
          if (json.job.phase === "done") {
            setAppUpdateNotice(json.job.message || "Update started.");
            void load();
          } else if (json.job.phase === "error") {
            setAppUpdateNotice(json.job.error || json.job.message || "Update failed.");
          }
        } catch {
          // keep polling
        }
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [appUpdateJobs, load]);

  const loadHubInfo = useCallback(async () => {
    if (serverUp === false) {
      setHubInfo(null);
      return;
    }
    try {
      const res = await fetch("/api/health");
      const json = (await res.json()) as {
        version?: string;
        bind?: string;
        port?: number;
        lanReachable?: boolean;
      };
      if (!res.ok) throw new Error("health failed");
      setHubInfo(json);
    } catch {
      setHubInfo(null);
    }
  }, [serverUp]);

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
    void loadHubInfo();
  }, [loadHubInfo]);

  useEffect(() => {
    if (serverUp === false) {
      closeAllPopovers();
      setOmbiItems([]);
      setOmbiError(null);
      setOmbiSuccess(null);
    }
  }, [serverUp, closeAllPopovers]);

  useEffect(() => {
    if (!ombiOpen) return;
    void loadOmbiPending();
  }, [ombiOpen, loadOmbiPending]);

  useEffect(() => {
    if (
      !hubOpen &&
      !companionOpen &&
      !queueOpen &&
      !downloadsOpen &&
      !ombiOpen &&
      !plexOpen
    )
      return;
    const downOutside = {
      hub: false,
      companion: false,
      queue: false,
      downloads: false,
      ombi: false,
      plex: false,
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (hubOpen && hubWrapRef.current && !hubWrapRef.current.contains(target)) {
        downOutside.hub = true;
      }
      if (
        companionOpen &&
        companionWrapRef.current &&
        !companionWrapRef.current.contains(target)
      ) {
        downOutside.companion = true;
      }
      if (
        queueOpen &&
        queueWrapRef.current &&
        !queueWrapRef.current.contains(target)
      ) {
        downOutside.queue = true;
      }
      if (
        downloadsOpen &&
        downloadsWrapRef.current &&
        !downloadsWrapRef.current.contains(target)
      ) {
        downOutside.downloads = true;
      }
      if (
        ombiOpen &&
        ombiWrapRef.current &&
        !ombiWrapRef.current.contains(target)
      ) {
        downOutside.ombi = true;
      }
      if (
        plexOpen &&
        plexWrapRef.current &&
        !plexWrapRef.current.contains(target)
      ) {
        downOutside.plex = true;
      }
    };
    const onPointerUp = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        downOutside.hub &&
        hubOpen &&
        hubWrapRef.current &&
        !hubWrapRef.current.contains(target)
      ) {
        setHubOpen(false);
      }
      if (
        downOutside.companion &&
        companionOpen &&
        companionWrapRef.current &&
        !companionWrapRef.current.contains(target)
      ) {
        setCompanionOpen(false);
      }
      if (
        downOutside.queue &&
        queueOpen &&
        queueWrapRef.current &&
        !queueWrapRef.current.contains(target)
      ) {
        setQueueOpen(false);
      }
      if (
        downOutside.downloads &&
        downloadsOpen &&
        downloadsWrapRef.current &&
        !downloadsWrapRef.current.contains(target)
      ) {
        setDownloadsOpen(false);
      }
      if (
        downOutside.ombi &&
        ombiOpen &&
        ombiWrapRef.current &&
        !ombiWrapRef.current.contains(target)
      ) {
        setOmbiOpen(false);
      }
      if (
        downOutside.plex &&
        plexOpen &&
        plexWrapRef.current &&
        !plexWrapRef.current.contains(target)
      ) {
        setPlexOpen(false);
      }
      downOutside.hub = false;
      downOutside.companion = false;
      downOutside.queue = false;
      downOutside.downloads = false;
      downOutside.ombi = false;
      downOutside.plex = false;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeAllPopovers();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("keydown", onKey);
    };
  }, [
    hubOpen,
    companionOpen,
    queueOpen,
    downloadsOpen,
    ombiOpen,
    plexOpen,
    closeAllPopovers,
  ]);

  const companionStatus = useMemo(
    () =>
      buildCompanionPcStatus(
        pcConfigs,
        pcs,
        serviceHealth,
        watchServices,
        services,
        scanning,
      ),
    [pcConfigs, pcs, serviceHealth, watchServices, services, scanning],
  );

  const companionChip = useMemo(
    () => companionChipMeta(companionStatus, scanning),
    [companionStatus, scanning],
  );

  const approveOmbi = async (item: OmbiPendingItem) => {
    const key = `${item.type}-${item.id}`;
    setOmbiApprovingId(key);
    setOmbiError(null);
    setOmbiSuccess(null);
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
      setOmbiSuccess(`Approved “${item.title}”.`);
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

  const downloadApps: {
    id: "qbittorrent" | "sabnzbd";
    label: string;
    data?: { ok: boolean; configured: boolean; active: number };
    openUrl: string | null;
  }[] = [
    {
      id: "qbittorrent",
      label: "qBittorrent",
      data: summary?.downloads?.qbittorrent,
      openUrl: serviceHomeUrl(urls.qbittorrent),
    },
    {
      id: "sabnzbd",
      label: "SABnzbd",
      data: summary?.downloads?.sabnzbd,
      openUrl: serviceHomeUrl(urls.sabnzbd),
    },
  ];

  const problemItems = arrApps.flatMap((app) =>
    (app.data?.issues ?? []).map((issue) => ({
      appId: app.id,
      appLabel: app.label,
      issue,
      openUrl: activityQueueUrl(urls[app.id]),
    })),
  );

  const arrUpdateCount = chipVersions?.hub?.arrUpdateCount ?? 0;
  const arrStatusRows = chipVersions?.arrs ?? [];
  const arrUpdates = arrStatusRows.filter((entry) => entry.updateAvailable);
  const companionAppVersions = chipVersions?.companion?.apps ?? [];
  const companionAppUpdateCount =
    chipVersions?.companion?.appUpdateCount ??
    companionAppVersions.filter((entry) => entry.updateAvailable).length;
  const companionAppUpdates = companionAppVersions.filter(
    (entry) => entry.updateAvailable,
  );

  const chips = [
    {
      id: "hub",
      label: "Hub",
      value: (() => {
        if (serverUp === false) return "down";
        if (serverUp !== true) return "…";
        if (arrUpdateCount > 0) {
          return arrUpdateCount === 1 ? "upd" : `${arrUpdateCount} upd`;
        }
        return "ok";
      })(),
      tone: (() => {
        if (serverUp === true && arrUpdateCount > 0) return "warn";
        if (serverUp === true) return "good";
        if (serverUp === false) return "bad";
        return "muted";
      })(),
    },
    ...(companionStatus && companionChip
      ? [
          {
            id: "companion",
            label: companionStatus.pc.name || "Companion",
            value:
              companionAppUpdateCount > 0 && companionChip.tone !== "bad"
                ? companionAppUpdateCount === 1
                  ? "upd"
                  : `${companionAppUpdateCount} upd`
                : companionChip.value,
            tone:
              companionAppUpdateCount > 0 && companionChip.tone !== "bad"
                ? "warn"
                : companionChip.tone,
          },
        ]
      : []),
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
        serverUp === false
          ? "—"
          : pendingSummary || streams == null
            ? "—"
            : summary?.streams?.configured
              ? String(streams)
              : "setup",
      tone:
        serverUp === false
          ? "muted"
          : streams && streams > 0
            ? "accent"
            : summary?.streams?.configured
              ? "muted"
              : "warn",
    },
    {
      id: "downloads",
      label: "Downloads",
      value:
        serverUp === false
          ? "—"
          : pendingSummary || downloads == null
            ? "—"
            : summary?.downloads?.qbittorrent?.configured ||
                summary?.downloads?.sabnzbd?.configured
              ? String(downloads)
              : "setup",
      tone:
        serverUp === false
          ? "muted"
          : downloads && downloads > 0
            ? "accent"
            : "muted",
    },
    {
      id: "queue",
      label: "*arr queue",
      value:
        serverUp === false
          ? "—"
          : pendingSummary || queueTotal == null
            ? "—"
            : summary?.arr?.sonarr?.ok ||
                summary?.arr?.radarr?.ok ||
                summary?.arr?.lidarr?.ok
              ? String(queueTotal)
              : "setup",
      tone:
        serverUp === false
          ? "muted"
          : queueTotal && queueTotal > 0
            ? "warn"
            : "muted",
    },
    {
      id: "ombi",
      label: "Ombi pending",
      value:
        serverUp === false
          ? "—"
          : pendingSummary || ombiPending == null
            ? "—"
            : summary?.ombi?.configured
              ? String(ombiPending)
              : "setup",
      tone:
        serverUp === false
          ? "muted"
          : ombiPending && ombiPending > 0
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
          if (chip.id === "hub") {
            const bind = hubInfo?.bind || "0.0.0.0";
            const port = hubInfo?.port ?? 3000;
            const lanOk = hubInfo?.lanReachable !== false;
            return (
              <div key={chip.id} className="dash-chip-wrap" ref={hubWrapRef}>
                <button
                  type="button"
                  className={`dash-chip dash-chip-btn tone-${chip.tone}`}
                  aria-expanded={hubOpen}
                  aria-haspopup="dialog"
                  title={
                    arrUpdateCount > 0
                      ? `Arrs Hub — ${arrUpdateCount} *arr update(s) available`
                      : "Arrs Hub API connectivity — click for bind / LAN tip"
                  }
                  onClick={() => {
                    if (hubOpen) {
                      setHubOpen(false);
                      return;
                    }
                    closeAllPopovers();
                    setHubOpen(true);
                    void loadHubInfo();
                  }}
                >
                  <span className="dash-chip-value">{chip.value}</span>
                  <span className="dash-chip-label">{chip.label}</span>
                  <ChipProductVersion
                    version={
                      chipVersions?.hub?.version || hubInfo?.version || null
                    }
                  />
                </button>
                {hubOpen && (
                  <div
                    className="dash-chip-popover"
                    role="dialog"
                    aria-label="Hub connectivity"
                  >
                    <p className="dash-chip-popover-title">Arrs Hub API</p>
                    <ul className="dash-queue-breakdown">
                      <li>
                        <span className="dash-queue-app-static">
                          <span>Status</span>
                          <strong>
                            {serverUp === true
                              ? "Online"
                              : serverUp === false
                                ? "Offline"
                                : "Checking…"}
                          </strong>
                        </span>
                      </li>
                      <li>
                        <span className="dash-queue-app-static">
                          <span>Version</span>
                          <strong>{hubInfo?.version || "—"}</strong>
                        </span>
                      </li>
                      <li>
                        <span className="dash-queue-app-static">
                          <span>Listen</span>
                          <strong>
                            {bind}:{port}
                          </strong>
                        </span>
                      </li>
                    </ul>
                    {serverUp === false ? (
                      <p className="dash-chip-popover-empty">
                        Hub API offline — start Arrs Hub / the tray app so
                        streams, queue, Plex update, and mobile can connect.
                      </p>
                    ) : lanOk ? (
                      <p className="dash-chip-popover-hint">
                        Listening on all interfaces ({bind}) — phones on LAN
                        (or port-forwarded :{port}) can reach the hub. Mobile
                        needs this; localhost-only blocks the phone.
                      </p>
                    ) : (
                      <p className="dash-chip-popover-hint">
                        Bound to localhost only — set{" "}
                        <code>ARRS_HUB_BIND=0.0.0.0</code> (default) so Arrs
                        Hub Mobile can connect on the LAN, then restart Hub.
                      </p>
                    )}
                    {arrStatusRows.length > 0 ? (
                      <>
                        <p className="dash-chip-popover-title">
                          Stack versions
                        </p>
                        <ul className="dash-queue-breakdown">
                          {arrStatusRows.map((app) => {
                            const job = appUpdateJobs[app.id];
                            const updating = job?.phase === "running";
                            const canClickUpdate =
                              Boolean(app.updateAvailable) &&
                              CLICK_UPDATE_APP_IDS.has(app.id) &&
                              !updating;
                            const value = updating
                              ? "updating…"
                              : job?.phase === "error"
                                ? "err"
                                : !app.configured
                                  ? "need key"
                                  : !app.ok
                                    ? app.error
                                      ? "err"
                                      : "—"
                                    : app.updateAvailable
                                      ? app.version
                                        ? `${app.version} → upd ${app.latestVersion || "?"}`
                                        : `upd → ${app.latestVersion || "?"}`
                                      : app.version || "—";
                            const rowTitle = app.error
                              ? app.error
                              : canClickUpdate
                                ? `Update ${app.label} in the background (Ctrl+click to open app)`
                                : app.openUrl
                                  ? `Open ${app.label}`
                                  : undefined;
                            const rowClass = [
                              app.updateAvailable || updating
                                ? "dash-queue-app-link dash-queue-app-update"
                                : "dash-queue-app-link",
                              updating ? "dash-queue-app-updating" : "",
                            ]
                              .filter(Boolean)
                              .join(" ");
                            const staticClass = [
                              app.updateAvailable
                                ? "dash-queue-app-static dash-queue-app-update"
                                : "dash-queue-app-static",
                              updating ? "dash-queue-app-updating" : "",
                            ]
                              .filter(Boolean)
                              .join(" ");
                            const row = (
                              <>
                                <span>{app.label}</span>
                                <strong>{value}</strong>
                              </>
                            );
                            const openApp = () => {
                              if (app.openUrl) {
                                window.open(
                                  app.openUrl,
                                  "_blank",
                                  "noopener,noreferrer",
                                );
                              }
                              setHubOpen(false);
                            };
                            return (
                              <li key={app.id}>
                                {canClickUpdate ? (
                                  <button
                                    type="button"
                                    className={`${rowClass} dash-queue-app-btn`}
                                    title={rowTitle}
                                    disabled={updating}
                                    onClick={(event) => {
                                      if (event.ctrlKey || event.metaKey) {
                                        openApp();
                                        return;
                                      }
                                      void startStackAppUpdate(app.id);
                                    }}
                                    onAuxClick={(event) => {
                                      if (event.button === 1) {
                                        event.preventDefault();
                                        openApp();
                                      }
                                    }}
                                  >
                                    {row}
                                  </button>
                                ) : app.openUrl ? (
                                  <a
                                    className={rowClass}
                                    href={app.openUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    title={rowTitle || `Open ${app.label}`}
                                    onClick={() => setHubOpen(false)}
                                  >
                                    {row}
                                  </a>
                                ) : (
                                  <span
                                    className={staticClass}
                                    title={rowTitle}
                                  >
                                    {row}
                                  </span>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                        {appUpdateNotice ? (
                          <p className="dash-chip-popover-hint">{appUpdateNotice}</p>
                        ) : null}
                        {arrUpdates.length > 0 ? (
                          <p className="dash-chip-popover-hint dash-chip-popover-hint-warn">
                            Click a yellow *arr / Tautulli row to update in the
                            background. Ctrl+click or middle-click opens the
                            app.
                          </p>
                        ) : (
                          <p className="dash-chip-popover-hint">
                            Enabled *arr apps with a Home URL appear here. Hover
                            &quot;need key&quot; / &quot;err&quot; for details.
                            FileFlows shows the local build when found.
                          </p>
                        )}
                      </>
                    ) : (
                      <p className="dash-chip-popover-hint">
                        Save *arr / Tautulli API keys in Settings → Apps &amp;
                        monitoring to check versions here.
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          }

          if (chip.id === "companion" && companionStatus) {
            const { pc, online, message, apps } = companionStatus;
            return (
              <div
                key={chip.id}
                className="dash-chip-wrap"
                ref={companionWrapRef}
              >
                <button
                  type="button"
                  className={`dash-chip dash-chip-btn tone-${chip.tone}`}
                  aria-expanded={companionOpen}
                  aria-haspopup="dialog"
                  title={`${pc.name} Companion PC — click for app status`}
                  onClick={() => {
                    if (companionOpen) {
                      setCompanionOpen(false);
                      return;
                    }
                    closeAllPopovers();
                    setCompanionOpen(true);
                  }}
                >
                  <span className="dash-chip-value">{chip.value}</span>
                  <span className="dash-chip-label">{chip.label}</span>
                  <ChipProductVersion
                    version={chipVersions?.companion?.version || null}
                  />
                </button>
                {companionOpen && (
                  <div
                    className="dash-chip-popover"
                    role="dialog"
                    aria-label={`${pc.name} companion status`}
                  >
                    <p className="dash-chip-popover-title">
                      {pc.name}
                      {pc.host ? ` · ${pc.host}` : ""}
                    </p>
                    <ul className="dash-queue-breakdown">
                      <li>
                        <span className="dash-queue-app-static">
                          <span>Companion</span>
                          <strong>
                            {online === true
                              ? "Online"
                              : online === false
                                ? "Offline"
                                : "Checking…"}
                            {chipVersions?.companion?.version
                              ? ` · v${chipVersions.companion.version}`
                              : ""}
                          </strong>
                        </span>
                      </li>
                      {pc.companionUrl ? (
                        <li>
                          <span className="dash-queue-app-static">
                            <span>LAN API</span>
                            <strong>{pc.companionUrl.replace(/^https?:\/\//, "")}</strong>
                          </span>
                        </li>
                      ) : null}
                    </ul>
                    {message ? (
                      <p className="dash-chip-popover-hint">{message}</p>
                    ) : null}
                    <p className="dash-chip-popover-title">Apps on this PC</p>
                    {(() => {
                      const byId = new Map(
                        apps.map((app) => [app.id, { ...app }]),
                      );
                      for (const ver of companionAppVersions) {
                        if (!byId.has(ver.id)) {
                          byId.set(ver.id, {
                            id: ver.id,
                            label: ver.label || ver.id,
                            up: null,
                            openUrl: ver.openUrl || null,
                            message: undefined,
                          });
                        }
                      }
                      const displayApps = [
                        "qbittorrent",
                        "sabnzbd",
                        "fileflows-node",
                        "fileflows",
                        "surfshark",
                      ]
                        .map((id) => byId.get(id))
                        .filter(
                          (app): app is NonNullable<typeof app> =>
                            Boolean(app),
                        )
                        .concat(
                          [...byId.values()].filter(
                            (app) =>
                              ![
                                "qbittorrent",
                                "sabnzbd",
                                "fileflows-node",
                                "fileflows",
                                "surfshark",
                              ].includes(app.id),
                          ),
                        );

                      if (displayApps.length === 0) {
                        return (
                          <p className="dash-chip-popover-empty">
                            No companion apps wired yet. In Port Watch, set
                            Restart on → {pc.name} for qBit, SAB, or FileFlows
                            Node.
                          </p>
                        );
                      }

                      return (
                        <ul className="dash-queue-breakdown">
                          {displayApps.map((app) => {
                            const verInfo = companionAppVersions.find(
                              (entry) => entry.id === app.id,
                            );
                            const job = appUpdateJobs[app.id];
                            const updating = job?.phase === "running";
                            const health =
                              app.up === null && verInfo?.version
                                ? "installed"
                                : companionAppHealthLabel(app.up);
                            let value = health;
                            if (updating) {
                              value = "updating…";
                            } else if (job?.phase === "error") {
                              value = "err";
                            } else if (verInfo?.updateAvailable) {
                              value = `upd → ${verInfo.latestVersion || "?"}`;
                            } else if (verInfo?.version) {
                              value =
                                app.up === null
                                  ? `v${verInfo.version}`
                                  : `${health} · v${verInfo.version}`;
                            } else if (
                              verInfo &&
                              !verInfo.ok &&
                              verInfo.configured
                            ) {
                              value = `${health} · ver?`;
                            }
                            const hasUpdate = Boolean(
                              verInfo?.updateAvailable,
                            );
                            const canClickUpdate =
                              hasUpdate &&
                              COMPANION_CLICK_UPDATE_IDS.has(app.id) &&
                              !updating;
                            const rowClass = [
                              hasUpdate || updating
                                ? "dash-queue-app-link dash-queue-app-update"
                                : "dash-queue-app-link",
                              updating ? "dash-queue-app-updating" : "",
                            ]
                              .filter(Boolean)
                              .join(" ");
                            const staticClass = [
                              hasUpdate || updating
                                ? "dash-queue-app-static dash-queue-app-update"
                                : "dash-queue-app-static",
                              updating ? "dash-queue-app-updating" : "",
                            ]
                              .filter(Boolean)
                              .join(" ");
                            const canOpen =
                              Boolean(app.openUrl) &&
                              app.id !== "fileflows-node" &&
                              app.id !== "surfshark";
                            const row = (
                              <>
                                <span>{app.label}</span>
                                <strong>{value}</strong>
                              </>
                            );
                            const openApp = () => {
                              if (app.openUrl) {
                                window.open(
                                  app.openUrl,
                                  "_blank",
                                  "noopener,noreferrer",
                                );
                              }
                              setCompanionOpen(false);
                            };
                            return (
                              <li key={app.id}>
                                {canClickUpdate ? (
                                  <button
                                    type="button"
                                    className={`${rowClass} dash-queue-app-btn`}
                                    title={`Update ${app.label} in the background via Companion (Ctrl+click to open)`}
                                    disabled={updating}
                                    onClick={(event) => {
                                      if (event.ctrlKey || event.metaKey) {
                                        openApp();
                                        return;
                                      }
                                      void startStackAppUpdate(app.id, pc.id);
                                    }}
                                  >
                                    {row}
                                  </button>
                                ) : canOpen ? (
                                  <a
                                    className={rowClass}
                                    href={app.openUrl!}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    title={
                                      hasUpdate
                                        ? `Update available for ${app.label}`
                                        : app.message || `Open ${app.label}`
                                    }
                                    onClick={() => setCompanionOpen(false)}
                                  >
                                    {row}
                                  </a>
                                ) : (
                                  <span
                                    className={staticClass}
                                    title={
                                      job?.error || app.message || undefined
                                    }
                                  >
                                    {row}
                                  </span>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      );
                    })()}
                    {companionAppUpdates.length > 0 ? (
                      <p className="dash-chip-popover-hint dash-chip-popover-hint-warn">
                        {companionAppUpdates.some((a) =>
                          COMPANION_CLICK_UPDATE_IDS.has(a.id),
                        )
                          ? "Yellow qBit/SAB rows: click to update in the background on this PC (winget)."
                          : `${companionAppUpdates.map((a) => a.label).join(", ")} have updates — install on ${pc.name}.`}
                      </p>
                    ) : (
                      <p className="dash-chip-popover-hint">
                        Status from Port Watch. Hover an app for the last check
                        detail (FileFlows Node uses Companion service/process
                        probe — Discord alerts only after consecutive confirmed
                        downs).
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          }

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
                onClick={() => {
                  closeAllPopovers();
                  onOpenStreams();
                }}
              >
                <span className="dash-chip-value">{chip.value}</span>
                <span className="dash-chip-label">{chip.label}</span>
              </button>
            );
          }

          if (chip.id === "downloads") {
            return (
              <div
                key={chip.id}
                className="dash-chip-wrap"
                ref={downloadsWrapRef}
              >
                <button
                  type="button"
                  className={`dash-chip dash-chip-btn tone-${chip.tone}`}
                  aria-expanded={downloadsOpen}
                  aria-haspopup="dialog"
                  title="Active downloads — click for qBittorrent / SABnzbd; open an app to jump to its UI"
                  onClick={() => {
                    setHubOpen(false);
                    setCompanionOpen(false);
                    setQueueOpen(false);
                    setOmbiOpen(false);
                    setPlexOpen(false);
                    setDownloadsOpen((open) => !open);
                  }}
                >
                  <span className="dash-chip-value">{chip.value}</span>
                  <span className="dash-chip-label">{chip.label}</span>
                </button>
                {downloadsOpen && (
                  <div
                    className="dash-chip-popover"
                    role="dialog"
                    aria-label="Downloads breakdown"
                  >
                    <p className="dash-chip-popover-title">
                      Active downloads
                      {downloads != null ? ` · ${downloads} total` : ""}
                    </p>
                    <ul className="dash-queue-breakdown">
                      {downloadApps.map((app) => {
                        const configured =
                          app.data?.configured || Boolean(app.openUrl);
                        const value = !configured
                          ? "—"
                          : app.data?.ok
                            ? String(app.data.active ?? 0)
                            : "err";
                        const row = (
                          <>
                            <span>{app.label}</span>
                            <strong>{value}</strong>
                          </>
                        );
                        return (
                          <li key={app.id}>
                            {app.openUrl ? (
                              <a
                                className="dash-queue-app-link"
                                href={app.openUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={`Open ${app.label}`}
                                onClick={() => setDownloadsOpen(false)}
                              >
                                {row}
                              </a>
                            ) : (
                              <span className="dash-queue-app-static">{row}</span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                    <p className="dash-chip-popover-hint">
                      Click qBittorrent or SABnzbd to open that download client.
                      If a row is not clickable, set its Home URL on the
                      dashboard service card (or Settings → Services).
                    </p>
                  </div>
                )}
              </div>
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
                  title="*arr queue — click for per-app counts; open an app to jump to its Activity Queue"
                  onClick={() => {
                    setHubOpen(false);
                    setCompanionOpen(false);
                    setDownloadsOpen(false);
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
                        const openUrl = activityQueueUrl(urls[app.id]);
                        const row = (
                          <>
                            <span>{app.label}</span>
                            <strong>{value}</strong>
                          </>
                        );
                        return (
                          <li key={app.id}>
                            {openUrl ? (
                              <a
                                className="dash-queue-app-link"
                                href={openUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={`Open ${app.label} Activity Queue`}
                                onClick={() => setQueueOpen(false)}
                              >
                                {row}
                              </a>
                            ) : (
                              <span className="dash-queue-app-static">{row}</span>
                            )}
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
                                Open Activity
                              </a>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                    {/* TODO: interactive Manual Import from hub (fetch /api/v3/manualimport
                        candidates, pick episode/movie, confirm) — deferred beyond this release. */}
                    <p className="dash-chip-popover-hint">
                      Click Sonarr / Radarr / Lidarr above to open that app&apos;s
                      Activity Queue. Matching still happens there; in-hub Manual
                      Import is planned later.
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
                    setHubOpen(false);
                    setQueueOpen(false);
                    setDownloadsOpen(false);
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
                    {ombiSuccess && !ombiError ? (
                      <p className="dash-chip-popover-hint dash-ombi-success">
                        {ombiSuccess}
                      </p>
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
                    setHubOpen(false);
                    setQueueOpen(false);
                    setDownloadsOpen(false);
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
