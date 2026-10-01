import type { ConnectionMode, ServiceConfig } from "../types";
import { getServiceUrl, isLocalServiceProbe } from "../types";
import type {
  PcWatchSummary,
  ServiceHealth,
  WatchServiceSummary,
} from "../hooks/useServiceHealth";

export const HUB_MACHINE_LABEL = "Hub PC (Plex)";

export type AppHealthRow = {
  id: string;
  label: string;
  message: string;
  openUrl: string | null;
};

export type MachineAppGroup = {
  machine: string;
  apps: AppHealthRow[];
};

function urlHost(url: string | null): string {
  if (!url) return "";
  try {
    return new URL(url.includes("://") ? url : `http://${url}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function machineFor(
  id: string,
  service: ServiceConfig | undefined,
  url: string | null,
  pcConfigs: PcWatchSummary[],
  watchServices: Record<string, WatchServiceSummary>,
): string {
  const companionOnly =
    id === "fileflows-node" ||
    id === "surfshark" ||
    String(url || "").toLowerCase().startsWith("companion:");
  if (companionOnly) {
    const pcId = String(watchServices[id]?.restartPcId || "");
    const pc =
      pcConfigs.find((item) => item.id === pcId) ||
      pcConfigs.find((item) => String(item.companionUrl || "").trim());
    return pc?.name || "Downloader PC";
  }
  if (!service || isLocalServiceProbe(service)) return HUB_MACHINE_LABEL;

  const host = urlHost(url);
  if (!host || isLoopback(host)) return HUB_MACHINE_LABEL;
  const pc = pcConfigs.find(
    (item) =>
      item.host.toLowerCase() === host || urlHost(item.companionUrl || "") === host,
  );
  return pc?.name || host;
}

/**
 * Group watched apps that match `pick` by the machine they run on.
 * Hub PC first, then other machines alphabetically.
 */
export function groupAppsByMachine(
  health: Record<string, ServiceHealth>,
  services: ServiceConfig[],
  pcConfigs: PcWatchSummary[],
  watchServices: Record<string, WatchServiceSummary>,
  mode: ConnectionMode,
  pick: (entry: ServiceHealth) => boolean,
  labels: Record<string, string> = {},
): MachineAppGroup[] {
  const groups = new Map<string, AppHealthRow[]>();
  for (const [id, entry] of Object.entries(health)) {
    if (!entry || !pick(entry)) continue;
    const service = services.find((item) => item.id === id);
    const url = service ? getServiceUrl(service, mode) : null;
    const machine = machineFor(id, service, url, pcConfigs, watchServices);
    const reason = entry.lastRestartResult
      ? `${entry.message || "Down"} · restart: ${entry.lastRestartResult}`
      : entry.message || "Down";
    const rows = groups.get(machine) ?? [];
    rows.push({
      id,
      label: service?.name || labels[id] || id,
      message: reason,
      openUrl: url && /^https?:\/\//i.test(url) ? url : null,
    });
    groups.set(machine, rows);
  }
  return [...groups.entries()]
    .map(([machine, apps]) => ({
      machine,
      apps: apps.sort((a, b) => a.label.localeCompare(b.label)),
    }))
    .sort((a, b) =>
      a.machine === HUB_MACHINE_LABEL
        ? -1
        : b.machine === HUB_MACHINE_LABEL
          ? 1
          : a.machine.localeCompare(b.machine),
    );
}
