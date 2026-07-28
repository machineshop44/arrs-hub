import { useMemo, useState } from "react";
import { useSettings } from "./hooks/useSettings";
import { useNetworkMode } from "./hooks/useNetworkMode";
import { useTrashUpdates } from "./hooks/useTrashUpdates";
import { useServiceHealth } from "./hooks/useServiceHealth";
import { SettingsPanel } from "./components/SettingsPanel";
import { ServiceSection } from "./components/ServiceSection";
import { TrashUpdateBanner } from "./components/TrashUpdateBanner";
import { SyncPanel } from "./components/SyncPanel";
import { WatchdogPanel } from "./components/WatchdogPanel";
import { WorkoutsPanel } from "./components/WorkoutsPanel";
import { CATEGORY_ORDER, getServiceUrl } from "./types";
import type { ConnectionPreference } from "./types";

export default function App() {
  const {
    settings,
    showSettings,
    setShowSettings,
    updateService,
    updateTitle,
    updateSubtitle,
    setConnectionPreference,
    resetSettings,
  } = useSettings();

  const [showSync, setShowSync] = useState(false);

  const { activeMode, checking } = useNetworkMode(
    settings.connectionPreference,
    settings.services,
  );

  const trashEnabled = settings.services.some(
    (s) => s.id === "trash-guides" && s.enabled,
  );
  const trash = useTrashUpdates(trashEnabled);
  const watchdog = useServiceHealth(settings.services);

  const [showWatchdog, setShowWatchdog] = useState(false);
  const [showWorkouts, setShowWorkouts] = useState(false);

  const plexService = settings.services.find((s) => s.id === "plex");
  const suggestedPlexUrl = plexService
    ? getServiceUrl(plexService, activeMode)
    : undefined;

  const servicesByCategory = useMemo(() => {
    const enabled = settings.services.filter((s) => s.enabled);
    return CATEGORY_ORDER.map((category) => ({
      category,
      services: enabled.filter((s) => s.category === category),
    })).filter((group) => group.services.length > 0);
  }, [settings.services]);

  const enabledCount = settings.services.filter((s) => s.enabled).length;

  const downCount = Object.values(watchdog.health).filter(
    (item) => item.up === false,
  ).length;
  const upCount = Object.values(watchdog.health).filter(
    (item) => item.up === true,
  ).length;

  const statusLabel = checking
    ? "Detecting network…"
    : activeMode === "home"
      ? "Using home links"
      : "Using remote links";

  const prefs: { id: ConnectionPreference; label: string }[] = [
    { id: "auto", label: "Auto" },
    { id: "home", label: "Home" },
    { id: "remote", label: "Remote" },
  ];

  const badges = trash.hasUpdate ? { "trash-guides": "Update" } : undefined;

  const openTrashGuides = () => {
    const service = settings.services.find((s) => s.id === "trash-guides");
    const url =
      (service && getServiceUrl(service, activeMode)) ||
      trash.snapshot?.guidesUrl ||
      "https://trash-guides.info/";
    window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="app">
      <header className="header">
        <div className="header-content">
          <div className="header-brand">
            <div className="logo">🎛️</div>
            <div>
              <h1>{settings.title}</h1>
              <p>{settings.subtitle}</p>
            </div>
          </div>
          <div className="header-actions">
            <div
              className="connection-toggle"
              role="group"
              aria-label="Connection preference"
              title="Auto picks Home or Remote from your network"
            >
              {prefs.map((pref) => (
                <button
                  key={pref.id}
                  type="button"
                  className={`connection-btn${settings.connectionPreference === pref.id ? " active" : ""}`}
                  onClick={() => setConnectionPreference(pref.id)}
                >
                  {pref.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="btn btn-ghost"
              title="Play warm-up + workout day on your Plex TV"
              onClick={() => setShowWorkouts(true)}
            >
              🏋️ Workouts
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              title="Monitor Home ports and auto-restart Windows services if an app goes down"
              onClick={() => setShowWatchdog(true)}
            >
              💓 Port Watch
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setShowSync(true)}
            >
              🗑️ Sync
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setShowSettings(true)}
            >
              ⚙️ Settings
            </button>
          </div>
        </div>
      </header>

      <main className="main">
        {trash.showBanner && trash.snapshot && (
          <TrashUpdateBanner
            snapshot={trash.snapshot}
            onDismiss={trash.markSeen}
            onOpenGuides={openTrashGuides}
            onOpenSync={() => setShowSync(true)}
          />
        )}

        {watchdog.serverUp && (
          <div className="watchdog-bar">
            <div>
              <strong>Port watch</strong>
              <span>
                {upCount} up · {downCount} down
                {watchdog.autoRestart
                  ? " · auto-restart on"
                  : " · auto-restart off"}
              </span>
              <small>
                Watching <strong>Home</strong> ports on this Plex PC. If a port
                stays down, Auto-restart starts the Windows service. Configure
                service names under <strong>Port Watch</strong>.
              </small>
            </div>
            <div className="watchdog-bar-actions">
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={watchdog.watchEnabled}
                  onChange={(e) =>
                    void watchdog.updateSettings({ enabled: e.target.checked })
                  }
                />
                <span className="toggle-label">Monitor</span>
              </label>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={watchdog.autoRestart}
                  onChange={(e) =>
                    void watchdog.updateSettings({
                      autoRestart: e.target.checked,
                    })
                  }
                />
                <span className="toggle-label">Auto-restart</span>
              </label>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void watchdog.checkNow()}
              >
                Check now
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setShowWatchdog(true)}
              >
                Configure
              </button>
            </div>
          </div>
        )}

        {enabledCount === 0 ? (
          <div className="empty-state">
            <p>No services enabled yet.</p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setShowSettings(true)}
            >
              Configure services
            </button>
          </div>
        ) : (
          servicesByCategory.map(({ category, services }) => (
            <ServiceSection
              key={category}
              category={category}
              services={services}
              connectionMode={activeMode}
              badges={badges}
              healthById={watchdog.health}
            />
          ))
        )}
      </main>

      <footer className="footer">
        <span>
          {enabledCount} services · {statusLabel}
          {settings.connectionPreference === "auto" ? " (auto)" : " (manual)"}
          {trash.loading ? " · Checking TRaSH…" : ""}
          {trash.error ? " · TRaSH check failed" : ""}
          {watchdog.serverUp === false ? " · Watchdog server offline" : ""}
        </span>
      </footer>

      {showSettings && (
        <SettingsPanel
          settings={settings}
          onClose={() => setShowSettings(false)}
          onUpdateService={updateService}
          onUpdateTitle={updateTitle}
          onUpdateSubtitle={updateSubtitle}
          onReset={resetSettings}
        />
      )}

      {showSync && (
        <SyncPanel
          onClose={() => setShowSync(false)}
          connectionMode={activeMode}
          services={settings.services}
        />
      )}

      {showWatchdog && (
        <WatchdogPanel
          onClose={() => setShowWatchdog(false)}
          serviceNames={settings.services.map((service) => ({
            id: service.id,
            name: service.name,
            enabled: service.enabled,
          }))}
        />
      )}

      {showWorkouts && (
        <WorkoutsPanel
          onClose={() => setShowWorkouts(false)}
          suggestedPlexUrl={suggestedPlexUrl}
        />
      )}
    </div>
  );
}
