import { useEffect } from "react";
import type { ServiceConfig } from "../types";

function isLocalServiceUrl(url: string) {
  try {
    const withProto = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)
      ? url
      : `http://${url}`;
    const hostname = new URL(withProto).hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1"
    );
  } catch {
    return true;
  }
}

/**
 * When a Companion registers, the hub stores downloader LAN URLs.
 * Apply them to local home URLs when still pointing at localhost.
 */
export function useCompanionUrlHints(
  services: ServiceConfig[],
  updateService: (id: string, updates: Partial<ServiceConfig>) => void,
) {
  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      try {
        const res = await fetch("/api/watchdog/companion-url-hints");
        if (!res.ok || cancelled) return;
        const json = await res.json();
        const hints = json?.hints as Record<string, string> | undefined;
        if (!hints) return;

        for (const [id, url] of Object.entries(hints)) {
          const service = services.find((item) => item.id === id);
          if (!service || !url?.trim()) continue;
          const current =
            service.homeUrl.trim() || service.defaultUrl || "";
          if (isLocalServiceUrl(current)) {
            updateService(id, { homeUrl: url.trim() });
          }
        }
      } catch {
        // hub may still be starting
      }
    };

    void run();
    const timer = setInterval(() => {
      void run();
    }, 60_000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [services, updateService]);
}
