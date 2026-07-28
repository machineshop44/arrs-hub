import { useCallback, useEffect, useMemo, useState } from "react";
import type { ConnectionMode, ServiceConfig } from "../types";
import { getServiceUrl } from "../types";

export type ServiceHealth = {
  up: boolean | null;
  latencyMs: number | null;
  lastChecked: string | null;
  consecutiveFails: number;
  lastRestartAt: string | null;
  lastRestartResult: string | null;
  message: string;
  mode?: ConnectionMode;
};

export type PcHealth = {
  online: boolean | null;
  lastChecked?: string | null;
  message?: string;
};

export function useServiceHealth(
  services: ServiceConfig[],
  activeMode: ConnectionMode,
) {
  const [health, setHealth] = useState<Record<string, ServiceHealth>>({});
  const [pcs, setPcs] = useState<Record<string, PcHealth>>({});
  const [pcCount, setPcCount] = useState(0);
  const [watchEnabled, setWatchEnabled] = useState(true);
  const [autoRestart, setAutoRestart] = useState(true);
  const [serverUp, setServerUp] = useState<boolean | null>(null);
  const [watchMode, setWatchMode] = useState<ConnectionMode>(activeMode);

  // Probe Home when home (restart possible). Probe Remote when away (status board only).
  const targets = useMemo(
    () =>
      services
        .filter((service) => service.enabled && service.id !== "trash-guides")
        .map((service) => {
          const url = getServiceUrl(service, activeMode);
          if (!url) return null;
          return {
            id: service.id,
            name: service.name,
            url,
            mode: activeMode,
            allowRestart: activeMode === "home",
          };
        })
        .filter(Boolean),
    [services, activeMode],
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
      setPcs(json.pcs ?? {});
      setPcCount(
        Array.isArray(json.settings?.pcs) ? json.settings.pcs.length : 0,
      );
      setWatchEnabled(Boolean(json.settings?.enabled));
      setAutoRestart(Boolean(json.settings?.autoRestart));
      setWatchMode(activeMode);
    } catch {
      setServerUp(false);
    }
  }, [targets, activeMode]);

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
    pcs,
    pcCount,
    watchEnabled,
    autoRestart,
    serverUp,
    watchMode,
    refresh,
    checkNow,
    updateSettings,
  };
}
