import { CATEGORY_LABELS } from "../types";
import type { ConnectionMode, ServiceCategory, ServiceConfig } from "../types";
import { ServiceCard } from "./ServiceCard";

interface ServiceSectionProps {
  category: ServiceCategory;
  services: ServiceConfig[];
  connectionMode: ConnectionMode;
}

export function ServiceSection({
  category,
  services,
  connectionMode,
}: ServiceSectionProps) {
  if (services.length === 0) return null;

  return (
    <section className="service-section">
      <h2 className="section-title">{CATEGORY_LABELS[category]}</h2>
      <div className="service-grid">
        {services.map((service) => (
          <ServiceCard
            key={service.id}
            service={service}
            connectionMode={connectionMode}
          />
        ))}
      </div>
    </section>
  );
}
