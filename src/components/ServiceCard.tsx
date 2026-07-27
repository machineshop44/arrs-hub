import type { CSSProperties } from "react";
import type { ConnectionMode, ServiceConfig } from "../types";
import { getServiceUrl } from "../types";

interface ServiceCardProps {
  service: ServiceConfig;
  connectionMode: ConnectionMode;
}

export function ServiceCard({ service, connectionMode }: ServiceCardProps) {
  const activeUrl = getServiceUrl(service, connectionMode);
  const isRemoteMissing =
    connectionMode === "remote" && !service.remoteUrl.trim();

  const handleClick = () => {
    if (!activeUrl) return;
    window.open(activeUrl, "_blank", "noopener,noreferrer");
  };

  return (
    <button
      type="button"
      className={`service-card${isRemoteMissing ? " service-card-disabled" : ""}`}
      onClick={handleClick}
      disabled={!activeUrl}
      style={{ "--accent": service.color } as CSSProperties}
      title={
        activeUrl
          ? `Open ${service.name}`
          : `${service.name} — remote URL not set`
      }
    >
      <div className="service-card-icon">{service.icon}</div>
      <div className="service-card-body">
        <h3>{service.name}</h3>
        <p>{service.description}</p>
        <span className="service-card-url">
          {activeUrl ?? "Remote URL not configured"}
        </span>
      </div>
      <span className="service-card-arrow" aria-hidden="true">
        →
      </span>
    </button>
  );
}
