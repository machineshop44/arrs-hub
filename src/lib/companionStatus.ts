import type { ServiceConfig } from "../types";
import { getServiceUrl } from "../types";
import type { PcHealth, ServiceHealth } from "../hooks/useServiceHealth";

export type PcWatchSummary = {
  id: string;
  name: string;
  host: string;
  companionUrl?: string;
};

export type WatchServiceSummary = {
  restartPcId?: string;
  monitor?: boolean;
};

export type CompanionAppStatus = {
  id: string;
  label: string;
  up: boolean | null;
  message?: string;
  openUrl: string | null;
};

export type CompanionPcStatus = {
  pc: PcWatchSummary;
  online: boolean | null;
  message?: string;
  apps: CompanionAppStatus[];
};

const COMPANION_FALLBACK_IDS = [
  "qbittorrent",
  "sabnzbd",
  "fileflows-node",
] as const;

function healthLabel(up: boolean | null): string {
  if (up === true) return "up";
  if (up === false) return "down";
  return "…";
}

export function buildCompanionPcStatus(
  pcConfigs: PcWatchSummary[],
  pcs: Record<string, PcHealth>,
  health: Record<string, ServiceHealth>,
  watchServices: Record<string, WatchServiceSummary>,
  services: ServiceConfig[],
  _scanning: boolean,
): CompanionPcStatus | null {
  const pc = pcConfigs.find((item) => String(item.companionUrl || "").trim());
  if (!pc) return null;

  const wiredIds = Object.entries(watchServices)
    .filter(
      ([, cfg]) =>
        cfg?.monitor !== false && String(cfg?.restartPcId || "") === pc.id,
    )
    .map(([id]) => id);

  const candidateIds =
    wiredIds.length > 0
      ? wiredIds
      : COMPANION_FALLBACK_IDS.filter((id) =>
          services.some((service) => service.id === id && service.enabled),
        );

  const apps: CompanionAppStatus[] = [];
  for (const id of candidateIds) {
    const service = services.find((item) => item.id === id && item.enabled);
    if (!service) continue;
    const entry = health[id];
    apps.push({
      id,
      label: service.name,
      up: entry?.up ?? null,
      message: entry?.message,
      openUrl: getServiceUrl(service, "home") || getServiceUrl(service, "remote"),
    });
  }

  return {
    pc,
    online: pcs[pc.id]?.online ?? null,
    message: pcs[pc.id]?.message,
    apps,
  };
}

export function companionChipMeta(
  summary: CompanionPcStatus | null,
  scanning: boolean,
): { value: string; tone: string } | null {
  if (!summary) return null;

  const appsUp = summary.apps.filter((app) => app.up === true).length;
  const appsDown = summary.apps.filter((app) => app.up === false).length;
  const appsTotal = summary.apps.length;

  if (scanning && summary.online === null && appsUp === 0 && appsDown === 0) {
    return { value: "…", tone: "muted" };
  }

  if (summary.online === false) {
    return { value: "off", tone: "bad" };
  }

  if (appsDown > 0) {
    return {
      value: appsTotal > 0 ? `${appsUp}/${appsTotal}` : "down",
      tone: "bad",
    };
  }

  if (summary.online === true) {
    if (appsTotal === 0) return { value: "ok", tone: "good" };
    if (appsUp === appsTotal) {
      return { value: appsTotal > 1 ? `${appsUp}/${appsTotal}` : "ok", tone: "good" };
    }
    return { value: `${appsUp}/${appsTotal}`, tone: "warn" };
  }

  return { value: "…", tone: "muted" };
}

export { healthLabel as companionAppHealthLabel };
