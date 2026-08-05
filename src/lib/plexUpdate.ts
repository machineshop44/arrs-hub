/** Client types + helpers for GET/POST /api/plex/update* (matches mobile plexUpdateApi). */

export type PlexUpdateJobPhase =
  | "idle"
  | "checking"
  | "downloading"
  | "applying"
  | "done"
  | "error";

export type PlexUpdateJob = {
  id?: string | null;
  phase?: PlexUpdateJobPhase;
  progress?: number;
  message?: string;
  error?: string | null;
};

export type PlexUpdateStatus = {
  ok?: boolean;
  installedVersion?: string | null;
  latestVersion?: string | null;
  updateAvailable?: boolean;
  canInstall?: boolean;
  /** "pms" | "windows-installer" when Install is available */
  installMethod?: "pms" | "windows-installer" | null;
  /** "pms" when /updater/status lists a Release; "plex.tv" when catalog is newer/sole source */
  channel?: string | null;
  releaseState?: string | null;
  downloadURL?: string | null;
  lastChecked?: string | null;
  platform?: string;
  hubLocal?: boolean;
  error?: string | null;
  job?: PlexUpdateJob;
};

export type PlexUpdateStartBody = {
  download?: boolean;
  apply?: boolean;
  tonight?: boolean;
};

export function shortPlexVersion(version: string | null | undefined): string {
  if (!version) return "—";
  return version.split("-")[0] || version;
}

export function plexJobBusy(
  job: PlexUpdateJob | null | undefined,
): boolean {
  const phase = job?.phase;
  return (
    phase === "checking" ||
    phase === "downloading" ||
    phase === "applying"
  );
}

export function plexCheckResultMessage(next: PlexUpdateStatus): string {
  if (next.updateAvailable) {
    return `Update available: ${shortPlexVersion(next.installedVersion)} → ${shortPlexVersion(next.latestVersion)}`;
  }
  if (next.ok && next.installedVersion) return "Up to date";
  if (next.error) return next.error;
  return "Check finished.";
}

export function plexInstallBlockedReason(
  status: PlexUpdateStatus | null,
  serverUp: boolean | null,
): string | null {
  if (serverUp === false)
    return "Hub offline — cannot check or install updates.";
  if (status?.updateAvailable && !status.canInstall) {
    if (status.error?.trim()) return status.error.trim();
    if (status.channel === "plex.tv") {
      return "Seen on plex.tv, but Install is unavailable from this hub (need win32 hub on the PMS PC, or wait for PMS /updater).";
    }
    return "Plex reports canInstall=false (manual/NAS installs cannot be applied from the hub).";
  }
  if (status && !status.canInstall) {
    if (status.error?.trim()) return status.error.trim();
    return "Plex reports canInstall=false (manual/NAS installs cannot be applied from the hub).";
  }
  return null;
}

export async function fetchPlexUpdateStatus(
  refresh = false,
): Promise<PlexUpdateStatus> {
  const qs = refresh ? "?refresh=1" : "";
  const res = await fetch(`/api/plex/update-status${qs}`);
  const json = (await res.json()) as PlexUpdateStatus & { error?: string };
  if (!res.ok) throw new Error(json.error || "Plex update status failed");
  return json;
}

export async function fetchPlexUpdateJob(): Promise<PlexUpdateJob> {
  const res = await fetch("/api/plex/update-job");
  const json = (await res.json()) as {
    ok?: boolean;
    job?: PlexUpdateJob;
    error?: string;
  };
  if (!res.ok) throw new Error(json.error || "Job poll failed");
  return json.job ?? { phase: "idle", progress: 0 };
}

export async function postPlexUpdateJob(
  body: PlexUpdateStartBody,
): Promise<PlexUpdateJob> {
  const res = await fetch("/api/plex/update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as {
    ok?: boolean;
    job?: PlexUpdateJob;
    error?: string;
  };
  if (!res.ok) throw new Error(json.error || "Request failed");
  return json.job ?? { phase: "idle", progress: 0 };
}

export function confirmPlexApply(tonight: boolean): boolean {
  return window.confirm(
    tonight
      ? "Schedule Plex Media Server update for tonight (Butler)? Active streams may still be interrupted when it applies."
      : "Apply Plex Media Server update now? PMS will restart and active streams will disconnect.",
  );
}
