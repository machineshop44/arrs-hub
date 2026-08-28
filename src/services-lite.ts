import { DEFAULT_SERVICES } from "./services";

export const LITE_SERVICE_IDS = ["qbittorrent", "sabnzbd"] as const;

export const LITE_SERVICES = DEFAULT_SERVICES.filter((service) =>
  LITE_SERVICE_IDS.includes(service.id as typeof LITE_SERVICE_IDS[number]),
);
