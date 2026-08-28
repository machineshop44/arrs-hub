import { useCallback, useEffect, useState } from "react";
import { DEFAULT_SERVICES } from "../services";
import { LITE_SERVICES } from "../services-lite";
import { IS_LITE_VARIANT } from "../variant";
import type {
  AppSettings,
  ConnectionPreference,
  ServiceConfig,
} from "../types";

const STORAGE_KEY = IS_LITE_VARIANT
  ? "arrs-hub-lite-settings"
  : "arrs-hub-settings";
const REMOTE_URLS_MIGRATION_KEY = IS_LITE_VARIANT
  ? "arrs-hub-lite-remote-urls-v1"
  : "arrs-hub-remote-urls-v1";

const catalogServices = IS_LITE_VARIANT ? LITE_SERVICES : DEFAULT_SERVICES;

const defaultSettings = (): AppSettings => ({
  title: IS_LITE_VARIANT ? "Arr's Hub Lite" : "Arr's Hub",
  subtitle: IS_LITE_VARIANT
    ? "qBit & SAB port watch for downloaders"
    : "Your Plex & *arr stack in one place",
  connectionPreference: "auto",
  services: catalogServices.map((service) => ({
    ...service,
    homeUrl: service.defaultUrl,
    remoteUrl: service.defaultRemoteUrl ?? "",
    enabled: service.defaultEnabled !== false,
  })),
});

function migrateService(
  service: ServiceConfig & { url?: string },
): ServiceConfig {
  const definition = catalogServices.find((item) => item.id === service.id);
  return {
    ...service,
    ...(definition ?? {}),
    homeUrl: service.homeUrl ?? service.url ?? service.defaultUrl,
    remoteUrl: service.remoteUrl ?? "",
    enabled: service.enabled,
  };
}

function fillMissingRemoteUrls(services: ServiceConfig[]): ServiceConfig[] {
  // One-time restore from bookmark-backed defaults when remotes were blank
  // (e.g. after switching from Chrome to the tray app).
  const alreadyMigrated =
    localStorage.getItem(REMOTE_URLS_MIGRATION_KEY) === "1";
  if (alreadyMigrated) return services;

  const next = services.map((service) => {
    const definition = catalogServices.find((item) => item.id === service.id);
    if (service.remoteUrl?.trim() || !definition?.defaultRemoteUrl) {
      return service;
    }
    return { ...service, remoteUrl: definition.defaultRemoteUrl };
  });

  localStorage.setItem(REMOTE_URLS_MIGRATION_KEY, "1");
  return next;
}

function loadSettings(): AppSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return defaultSettings();

    const parsed = JSON.parse(stored) as AppSettings & {
      connectionMode?: "home" | "remote";
      services: (ServiceConfig & { url?: string })[];
    };
    const knownIds = new Set(catalogServices.map((s) => s.id));
    const storedIds = new Set(parsed.services.map((s) => s.id));

    const merged = catalogServices.filter((s) => !storedIds.has(s.id)).map(
      (service) => ({
        ...service,
        homeUrl: service.defaultUrl,
        remoteUrl: service.defaultRemoteUrl ?? "",
        enabled: service.defaultEnabled !== false,
      }),
    );

    const services = fillMissingRemoteUrls([
      ...parsed.services
        .filter((s) => knownIds.has(s.id))
        .map((s) => migrateService(s)),
      ...merged,
    ]);

    const connectionPreference: ConnectionPreference =
      parsed.connectionPreference ??
      (parsed.connectionMode === "home" || parsed.connectionMode === "remote"
        ? "auto"
        : "auto");

    return {
      title: parsed.title || defaultSettings().title,
      subtitle: parsed.subtitle || defaultSettings().subtitle,
      connectionPreference,
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

  const setConnectionPreference = useCallback(
    (connectionPreference: ConnectionPreference) => {
      setSettings((prev) => ({ ...prev, connectionPreference }));
    },
    [],
  );

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
    setConnectionPreference,
    resetSettings,
  };
}
