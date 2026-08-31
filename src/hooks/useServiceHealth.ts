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
  /** True until the first port-check cycle has results (or server is unreachable). */
  const [scanning, setScanning] = useState(true);

  // Probe Home when home (restart possible). Probe Remote when away (status board only).
  // FileFlows Node has no TCP URL — Hub asks Companion for Windows service/process status.
  const targets = useMemo(
    () =>
      services
        .filter((service) => service.enabled && service.id !== "trash-guides")
        .map((service) => {
          const url = getServiceUrl(service, activeMode);
          const companionProbe =
            service.id === "fileflows-node" ||
            String(service.homeUrl || "")
              .trim()
              .toLowerCase()
              .startsWith("companion:");
          if (!url && !companionProbe) return null;
          return {
            id: service.id,
            name: service.name,
            url: url || "companion://local",
            mode: activeMode,
            allowRestart: activeMode === "home",
            probe: companionProbe ? ("companion" as const) : ("tcp" as const),
          };
        })
        .filter(
          (target): target is NonNullable<typeof target> => target != null,
        ),
    [services, activeMode],
  );

  const applyStatusPayload = useCallback(
    (json: {
      services?: Record<string, ServiceHealth>;
      pcs?: Record<string, PcHealth>;
      settings?: { pcs?: unknown[]; enabled?: boolean; autoRestart?: boolean };
    }) => {
      const nextHealth = json.services ?? {};
      setHealth(nextHealth);
      setPcs(json.pcs ?? {});
      setPcCount(
        Array.isArray(json.settings?.pcs) ? json.settings.pcs.length : 0,
      );
      setWatchEnabled(Boolean(json.settings?.enabled));
      setAutoRestart(Boolean(json.settings?.autoRestart));
      setWatchMode(activeMode);

      if (targets.length === 0) {
        setScanning(false);
        return;
      }
      const allChecked = targets.every((target) => {
        const entry = nextHealth[target.id];
        return Boolean(entry?.lastChecked);
      });
      if (allChecked) setScanning(false);
    },
    [activeMode, targets],
  );

  const refresh = useCallback(async () => {
    try {
      const healthRes = await fetch("/api/health");
      setServerUp(healthRes.ok);
      if (!healthRes.ok) {
        setScanning(false);
        return;
      }

      await fetch("/api/watchdog/targets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targets }),
      });

      const statusRes = await fetch("/api/watchdog/status");
      if (!statusRes.ok) return;
      const json = await statusRes.json();
      applyStatusPayload(json);
    } catch {
      setServerUp(false);
      setScanning(false);
    }
  }, [targets, applyStatusPayload]);

  const checkNow = useCallback(async () => {
    setScanning(true);
    await fetch("/api/watchdog/targets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targets }),
    });
    await fetch("/api/watchdog/check", { method: "POST" });
    await refresh();
  }, [targets, refresh]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setScanning(true);
      await refresh();
      if (cancelled) return;
      try {
        await fetch("/api/watchdog/targets", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targets }),
        });
        await fetch("/api/watchdog/check", { method: "POST" });
        if (!cancelled) await refresh();
      } catch {
        if (!cancelled) setScanning(false);
      }
    };
    void run();
    const timer = setInterval(() => {
      void refresh();
    }, 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [refresh, targets]);

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

  return {
    health,
    pcs,
    pcCount,
    watchEnabled,
    autoRestart,
    serverUp,
    watchMode,
    scanning,
    refresh,
    checkNow,
    updateSettings,
  };
}
