import { useCallback, useEffect, useState } from "react";
import { DEFAULT_SERVICES } from "../services";
import type { AppSettings, ConnectionMode, ServiceConfig } from "../types";

const STORAGE_KEY = "arrs-hub-settings";

const defaultSettings = (): AppSettings => ({
  title: "Arr's Hub",
  subtitle: "Your Plex & *arr stack in one place",
  connectionMode: "home",
  services: DEFAULT_SERVICES.map((service) => ({
    ...service,
    homeUrl: service.defaultUrl,
    remoteUrl: "",
    enabled: true,
  })),
});

function migrateService(
  service: ServiceConfig & { url?: string },
): ServiceConfig {
  return {
    ...service,
    homeUrl: service.homeUrl ?? service.url ?? service.defaultUrl,
    remoteUrl: service.remoteUrl ?? "",
  };
}

function loadSettings(): AppSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return defaultSettings();

    const parsed = JSON.parse(stored) as AppSettings & {
      services: (ServiceConfig & { url?: string })[];
    };
    const knownIds = new Set(DEFAULT_SERVICES.map((s) => s.id));
    const storedIds = new Set(parsed.services.map((s) => s.id));

    const merged = DEFAULT_SERVICES.filter((s) => !storedIds.has(s.id)).map(
      (service) => ({
        ...service,
        homeUrl: service.defaultUrl,
        remoteUrl: "",
        enabled: false,
      }),
    );

    const services = [
      ...parsed.services
        .filter((s) => knownIds.has(s.id))
        .map((s) => migrateService(s)),
      ...merged,
    ];

    return {
      title: parsed.title || defaultSettings().title,
      subtitle: parsed.subtitle || defaultSettings().subtitle,
      connectionMode: parsed.connectionMode ?? "home",
      services,
    };
  } catch {
    return defaultSettings();
  }
}

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  const updateService = useCallback(
    (id: string, updates: Partial<ServiceConfig>) => {
      setSettings((prev) => ({
        ...prev,
        services: prev.services.map((service) =>
          service.id === id ? { ...service, ...updates } : service,
        ),
      }));
    },
    [],
  );

  const updateTitle = useCallback((title: string) => {
    setSettings((prev) => ({ ...prev, title }));
  }, []);

  const updateSubtitle = useCallback((subtitle: string) => {
    setSettings((prev) => ({ ...prev, subtitle }));
  }, []);

  const setConnectionMode = useCallback((connectionMode: ConnectionMode) => {
    setSettings((prev) => ({ ...prev, connectionMode }));
  }, []);

  const resetSettings = useCallback(() => {
    setSettings(defaultSettings());
  }, []);

  return {
    settings,
    showSettings,
    setShowSettings,
    updateService,
    updateTitle,
    updateSubtitle,
    setConnectionMode,
    resetSettings,
  };
}
