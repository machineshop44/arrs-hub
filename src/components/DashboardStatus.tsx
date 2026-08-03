import { useCallback, useEffect, useState } from "react";
import type { ConnectionMode, ServiceConfig } from "../types";
import { getServiceUrl } from "../types";

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
    sonarr?: { ok: boolean; total: number; downloading: number; items?: ArrItem[] };
    radarr?: { ok: boolean; total: number; downloading: number; items?: ArrItem[] };
  };
};

type ArrItem = {
  title: string;
  status: string;
  sizeleft?: number;
  size?: number;
};

interface DashboardStatusProps {
  services: ServiceConfig[];
  connectionMode: ConnectionMode;
  upCount: number;
  downCount: number;
  serverUp: boolean | null;
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

export function DashboardStatus({
  services,
  connectionMode,
  upCount,
  downCount,
  serverUp,
}: DashboardStatusProps) {
  const [summary, setSummary] = useState<HubStatusSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const streams = summary?.streams?.streamCount ?? null;
  const downloads = summary?.downloads?.active ?? null;
  const ombiPending = summary?.ombi?.pending ?? null;
  const queueTotal = summary?.arr?.queueTotal ?? null;

  const chips = [
    {
      id: "up",
      label: "Apps up",
      value: String(upCount),
      tone: upCount > 0 ? "good" : "muted",
    },
    {
      id: "down",
      label: "Apps down",
      value: String(downCount),
      tone: downCount > 0 ? "bad" : "good",
    },
    {
      id: "streams",
      label: "Streams",
      value:
        streams == null
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
        downloads == null
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
        queueTotal == null
          ? "—"
          : summary?.arr?.sonarr?.ok || summary?.arr?.radarr?.ok
            ? String(queueTotal)
            : "setup",
      tone: queueTotal && queueTotal > 0 ? "warn" : "muted",
    },
    {
      id: "ombi",
      label: "Ombi open",
      value:
        ombiPending == null
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

  const activityRows = [
    summary?.arr?.sonarr?.ok && summary.arr.sonarr.total > 0
      ? {
          name: "Sonarr",
          count: summary.arr.sonarr.total,
          items: summary.arr.sonarr.items ?? [],
        }
      : null,
    summary?.arr?.radarr?.ok && summary.arr.radarr.total > 0
      ? {
          name: "Radarr",
          count: summary.arr.radarr.total,
          items: summary.arr.radarr.items ?? [],
        }
      : null,
  ].filter(Boolean) as {
    name: string;
    count: number;
    items: ArrItem[];
  }[];

  return (
    <section className="dash-status" aria-label="Hub status summary">
      <div className="dash-chips">
        {chips.map((chip) => (
          <div key={chip.id} className={`dash-chip tone-${chip.tone}`}>
            <span className="dash-chip-value">{chip.value}</span>
            <span className="dash-chip-label">{chip.label}</span>
          </div>
        ))}
      </div>

      {activityRows.length > 0 && (
        <div className="dash-activity">
          <strong>Activity</strong>
          <div className="dash-activity-rows">
            {activityRows.map((row) => (
              <div key={row.name} className="dash-activity-row">
                <span className="dash-activity-name">
                  {row.name} · {row.count} in queue
                </span>
                <span className="dash-activity-items">
                  {row.items
                    .slice(0, 3)
                    .map((item) => item.title)
                    .join(" · ") || "Downloading…"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

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
