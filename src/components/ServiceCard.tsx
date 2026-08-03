import type { CSSProperties } from "react";
import type { ConnectionMode, ServiceConfig } from "../types";
import { getServiceUrl } from "../types";
import type { ServiceHealth } from "../hooks/useServiceHealth";

interface ServiceCardProps {
  service: ServiceConfig;
  connectionMode: ConnectionMode;
  badge?: string | null;
  health?: ServiceHealth | null;
}

function statusLabel(health?: ServiceHealth | null) {
  if (!health || health.up === null) return "Unknown";
  if (health.up) {
    return health.latencyMs != null ? `Up · ${health.latencyMs}ms` : "Up";
  }
  if (health.lastRestartResult) {
    return `Down · ${health.lastRestartResult}`;
  }
  return health.message || "Down";
}

export function ServiceCard({
  service,
  connectionMode,
  badge,
  health,
}: ServiceCardProps) {
  const activeUrl = getServiceUrl(service, connectionMode);
  const isRemoteMissing =
    connectionMode === "remote" && !service.remoteUrl.trim();

  const handleClick = () => {
    if (!activeUrl) return;
    window.open(activeUrl, "_blank", "noopener,noreferrer");
  };

  const statusClass =
    health?.up === true
      ? "status-up"
      : health?.up === false
        ? "status-down"
        : "status-unknown";

  return (
    <button
      type="button"
      className={`service-card${isRemoteMissing ? " service-card-disabled" : ""}`}
      onClick={handleClick}
      disabled={!activeUrl}
      style={{ "--accent": service.color } as CSSProperties}
      title={
        activeUrl
          ? `${service.name} — ${statusLabel(health)}`
          : `${service.name} — remote URL not set`
      }
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
          {activeUrl ?? "Remote URL not configured"}
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
