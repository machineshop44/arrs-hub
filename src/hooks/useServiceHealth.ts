import { useCallback, useEffect, useMemo, useState } from "react";
import type { ServiceConfig } from "../types";
import { getServiceUrl } from "../types";

export type ServiceHealth = {
  up: boolean | null;
  latencyMs: number | null;
  lastChecked: string | null;
  consecutiveFails: number;
  lastRestartAt: string | null;
  lastRestartResult: string | null;
  message: string;
};

export function useServiceHealth(services: ServiceConfig[]) {
  const [health, setHealth] = useState<Record<string, ServiceHealth>>({});
  const [watchEnabled, setWatchEnabled] = useState(true);
  const [autoRestart, setAutoRestart] = useState(true);
  const [serverUp, setServerUp] = useState<boolean | null>(null);

  // Always monitor Home URLs — restart only makes sense on the Plex PC itself
  const targets = useMemo(
    () =>
      services
        .filter((service) => service.enabled && service.id !== "trash-guides")
        .map((service) => {
          const url = getServiceUrl(service, "home");
          if (!url) return null;
          return { id: service.id, name: service.name, url };
        })
        .filter(Boolean),
    [services],
  );

  const refresh = useCallback(async () => {
    try {
      const healthRes = await fetch("/api/health");
      setServerUp(healthRes.ok);
      if (!healthRes.ok) return;

      await fetch("/api/watchdog/targets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targets }),
      });

      const statusRes = await fetch("/api/watchdog/status");
      if (!statusRes.ok) return;
      const json = await statusRes.json();
      setHealth(json.services ?? {});
      setWatchEnabled(Boolean(json.settings?.enabled));
      setAutoRestart(Boolean(json.settings?.autoRestart));
    } catch {
      setServerUp(false);
    }
  }, [targets]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 15000);
    return () => clearInterval(timer);
  }, [refresh]);

  const updateSettings = useCallback(
    async (partial: { enabled?: boolean; autoRestart?: boolean }) => {
      await fetch("/api/watchdog/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(partial),
      });
      await refresh();
    },
    [refresh],
  );

  const checkNow = useCallback(async () => {
    await fetch("/api/watchdog/targets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targets }),
    });
    await fetch("/api/watchdog/check", { method: "POST" });
    await refresh();
  }, [targets, refresh]);

  return {
    health,
    watchEnabled,
    autoRestart,
    serverUp,
    refresh,
    checkNow,
    updateSettings,
  };
}
