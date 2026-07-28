export type ServiceCategory =
  | "media-management"
  | "indexers"
  | "downloaders"
  | "requests"
  | "monitoring"
  | "automation"
  | "other";

export interface ServiceDefinition {
  id: string;
  name: string;
  description: string;
  category: ServiceCategory;
  defaultUrl: string;
  icon: string;
  color: string;
  /** Defaults to true when omitted */
  defaultEnabled?: boolean;
  /** Optional default remote URL (e.g. public sites usable everywhere) */
  defaultRemoteUrl?: string;
}

export type ConnectionMode = "home" | "remote";
/** Auto detects LAN vs away; home/remote force a mode. */
export type ConnectionPreference = "auto" | ConnectionMode;

export interface ServiceConfig extends ServiceDefinition {
  homeUrl: string;
  remoteUrl: string;
  enabled: boolean;
}

export interface AppSettings {
  title: string;
  subtitle: string;
  connectionPreference: ConnectionPreference;
  services: ServiceConfig[];
}

export function getServiceUrl(
  service: ServiceConfig,
  mode: ConnectionMode,
): string | null {
  const url =
    mode === "remote" ? service.remoteUrl.trim() : service.homeUrl.trim();
  if (url) return url;
  if (mode === "remote") return null;
  return service.defaultUrl;
}

export const CATEGORY_LABELS: Record<ServiceCategory, string> = {
  "media-management": "Media Management",
  indexers: "Indexers",
  downloaders: "Download Clients",
  requests: "Requests",
  monitoring: "Monitoring & Stats",
  automation: "Automation",
  other: "Other",
};

export const CATEGORY_ORDER: ServiceCategory[] = [
  "media-management",
  "indexers",
  "downloaders",
  "requests",
  "monitoring",
  "automation",
  "other",
];
