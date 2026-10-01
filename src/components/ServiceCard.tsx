import type { CSSProperties } from "react";
import type { ConnectionMode, ServiceConfig } from "../types";
import { getServiceUrl, isLocalServiceProbe } from "../types";
import type { ServiceHealth } from "../hooks/useServiceHealth";

interface ServiceCardProps {
  service: ServiceConfig;
  connectionMode: ConnectionMode;
  badge?: string | null;
  health?: ServiceHealth | null;
  /** When set, click opens in-app UI instead of the service URL. */
  onOpen?: () => void;
}

function statusLabel(health?: ServiceHealth | null) {
  if (!health) return "Unknown";
  if (health.up === null) return health.message || "Unknown";
  if (health.up) {
    return health.latencyMs != null ? `Up · ${health.latencyMs}ms` : "Up";
  }
  const reason = health.message || "Down";
  if (health.lastRestartResult && health.lastRestartResult !== health.message) {
    return `Down · ${reason} · restart: ${health.lastRestartResult}`;
  }
  return reason.startsWith("Down") ? reason : `Down · ${reason}`;
}

export function ServiceCard({
  service,
  connectionMode,
  badge,
  health,
  onOpen,
}: ServiceCardProps) {
  const activeUrl = getServiceUrl(service, connectionMode);
  const localOnly = isLocalServiceProbe(service);
  const companionOnly =
    service.id === "fileflows-node" ||
    service.id === "surfshark" ||
    String(activeUrl || "")
      .trim()
      .toLowerCase()
      .startsWith("companion:");
  const noWebUi = companionOnly || localOnly;
  const isRemoteMissing =
    connectionMode === "remote" && !service.remoteUrl.trim() && !noWebUi;

  const handleClick = () => {
    if (onOpen) {
      onOpen();
      return;
    }
    if (!activeUrl || noWebUi) return;
    window.open(activeUrl, "_blank", "noopener,noreferrer");
  };

  const statusClass =
    health?.up === true
      ? "status-up"
      : health?.up === false
        ? "status-down"
        : "status-unknown";

  const titleHint = onOpen
    ? `${service.name} — search & request in Hub`
    : localOnly
      ? `${service.name} — ${statusLabel(health)} (Windows service on the Hub PC)`
      : companionOnly
      ? `${service.name} — ${statusLabel(health)} (status via Companion)`
      : activeUrl
        ? `${service.name} — ${statusLabel(health)}`
        : `${service.name} — remote URL not set`;

  return (
    <button
      type="button"
      className={`service-card${isRemoteMissing && !onOpen ? " service-card-disabled" : ""}`}
      onClick={handleClick}
      disabled={
        onOpen
          ? false
          : isRemoteMissing || (!activeUrl && !noWebUi)
      }
      style={{ "--accent": service.color } as CSSProperties}
      title={titleHint}
    >
      {badge ? <span className="service-card-badge">{badge}</span> : null}
      <div className="service-card-icon">
        <img
          src={service.icon}
          alt={service.name}
          width={36}
          height={36}
          draggable={false}
        />
      </div>
      <div className="service-card-body">
        <h3>
          <span className={`status-dot ${statusClass}`} aria-hidden="true" />
          {service.name}
        </h3>
        <p>{service.description}</p>
        <span className="service-card-url">
          {onOpen
            ? "Search & request in Hub"
            : localOnly
              ? "Windows service on this PC (no web UI)"
              : companionOnly
              ? "Status via Companion (no web UI)"
              : (activeUrl ?? "Remote URL not configured")}
        </span>
        {service.id !== "trash-guides" && (
          <span className={`service-card-health ${statusClass}`}>
            {statusLabel(health)}
          </span>
        )}
      </div>
      <span className="service-card-arrow" aria-hidden="true">
        →
      </span>
    </button>
  );
}
