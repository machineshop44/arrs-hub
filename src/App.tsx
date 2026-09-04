import { useMemo, useState } from "react";
import { useSettings } from "./hooks/useSettings";
import { useNetworkMode } from "./hooks/useNetworkMode";
import { useTrashUpdates } from "./hooks/useTrashUpdates";
import { useServiceHealth } from "./hooks/useServiceHealth";
import { useCompanionUrlHints } from "./hooks/useCompanionUrlHints";
import { SettingsPanel } from "./components/SettingsPanel";
import { ServiceSection } from "./components/ServiceSection";
import { TrashUpdateBanner } from "./components/TrashUpdateBanner";
import { SyncPanel } from "./components/SyncPanel";
import { WorkoutsPanel } from "./components/WorkoutsPanel";
import { StreamsPanel } from "./components/StreamsPanel";
import { DashboardStatus } from "./components/DashboardStatus";
import { CATEGORY_ORDER, getServiceUrl } from "./types";
import type { ConnectionPreference } from "./types";
import { APP_VERSION_LABEL } from "./version";

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

  useCompanionUrlHints(settings.services, updateService);

  const [showSync, setShowSync] = useState(false);

  const { activeMode, checking } = useNetworkMode(
    settings.connectionPreference,
    settings.services,
  );

  const trashEnabled = settings.services.some(
    (s) => s.id === "trash-guides" && s.enabled,
  );
  const trash = useTrashUpdates(trashEnabled);
  const watchdog = useServiceHealth(settings.services, activeMode);

  const [settingsSection, setSettingsSection] = useState<string | null>(null);
  const [showWorkouts, setShowWorkouts] = useState(false);
  const [showStreams, setShowStreams] = useState(false);

  const plexService = settings.services.find((s) => s.id === "plex");
  const suggestedPlexUrl = plexService
    ? getServiceUrl(plexService, activeMode) ?? undefined
    : undefined;

  const tautulliService = settings.services.find((s) => s.id === "tautulli");
  const suggestedTautulliUrl = tautulliService
    ? getServiceUrl(tautulliService, activeMode) ?? undefined
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
  const pcsOnline = Object.values(watchdog.pcs).filter(
    (item) => item.online === true,
  ).length;
  const pcsOffline = Object.values(watchdog.pcs).filter(
    (item) => item.online === false,
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
              title="Apps, API keys, port watch & restart"
              onClick={() => {
                setSettingsSection("apps-monitoring");
                setShowSettings(true);
              }}
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
              onClick={() => {
                setSettingsSection(null);
                setShowSettings(true);
              }}
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

        <DashboardStatus
          services={settings.services}
          connectionMode={activeMode}
          upCount={upCount}
          downCount={downCount}
          serverUp={watchdog.serverUp}
          scanning={watchdog.scanning}
          pcConfigs={watchdog.pcConfigs}
          pcs={watchdog.pcs}
          serviceHealth={watchdog.health}
          watchServices={watchdog.watchServices}
          onOpenStreams={() => setShowStreams(true)}
        />

        {(watchdog.serverUp || watchdog.scanning || watchdog.serverUp === null) && (
          <div className="watchdog-bar">
            <div>
              <strong>Port watch</strong>
              {watchdog.scanning || watchdog.serverUp === null ? (
                <span className="port-scan-status" role="status" aria-live="polite">
                  <span className="port-scan-spinner" aria-hidden="true" />
                  Searching ports…
                </span>
              ) : (
                <span>
                  {upCount} up · {downCount} down
                  {watchdog.pcCount > 0
                    ? ` · PCs ${pcsOnline} online / ${pcsOffline} offline`
                    : ""}
                  {activeMode === "remote"
                    ? " · remote status"
                    : watchdog.autoRestart
                      ? " · auto-restart on"
                      : " · auto-restart off"}
                </span>
              )}
              <small>
                {watchdog.scanning || watchdog.serverUp === null ? (
                  <>Checking enabled service ports — status chips update when the first scan finishes.</>
                ) : activeMode === "remote" ? (
                  <>
                    Watching <strong>Remote</strong> URLs from this PC (status
                    board while you&apos;re away). Auto-restart stays Home /
                    Plex-PC only.
                  </>
                ) : (
                  <>
                    Watching <strong>Home</strong> ports on this Plex PC. If a
                    port stays down, Auto-restart starts the Windows service
                    (or optional exe fallback). Use <strong>Port Watch</strong>{" "}
                    for service names / exe paths.
                  </>
                )}
              </small>
            </div>
            <div className="watchdog-bar-actions">
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={watchdog.watchEnabled}
                  disabled={watchdog.serverUp !== true}
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
                  disabled={
                    activeMode === "remote" || watchdog.serverUp !== true
                  }
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
                disabled={watchdog.serverUp !== true}
                onClick={() => void watchdog.checkNow()}
              >
                Check now
              </button>
            </div>
          </div>
        )}

        {watchdog.serverUp === false && !watchdog.scanning && (
          <div className="watchdog-bar watchdog-bar-offline">
            <div>
              <strong>Port watch</strong>
              <span>Hub API offline — start the server to monitor ports.</span>
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
          {APP_VERSION_LABEL} · {enabledCount} services · {statusLabel}
          {settings.connectionPreference === "auto" ? " (auto)" : " (manual)"}
          {watchdog.scanning ? " · Searching ports…" : ""}
          {trash.loading ? " · Checking TRaSH…" : ""}
          {trash.error ? " · TRaSH check failed" : ""}
          {watchdog.serverUp === false ? " · Watchdog server offline" : ""}
        </span>
      </footer>

      {showSettings && (
        <SettingsPanel
          settings={settings}
          initialSection={settingsSection}
          onClose={() => {
            setShowSettings(false);
            setSettingsSection(null);
          }}
          onUpdateService={updateService}
          onUpdateTitle={updateTitle}
          onUpdateSubtitle={updateSubtitle}
          onReset={resetSettings}
          onOpenStreams={() => {
            setShowSettings(false);
            setSettingsSection(null);
            setShowStreams(true);
          }}
        />
      )}

      {showSync && (
        <SyncPanel
          onClose={() => setShowSync(false)}
          connectionMode={activeMode}
          services={settings.services}
        />
      )}

      {showWorkouts && (
        <WorkoutsPanel
          onClose={() => setShowWorkouts(false)}
          suggestedPlexUrl={suggestedPlexUrl}
        />
      )}

      {showStreams && (
        <StreamsPanel
          onClose={() => setShowStreams(false)}
          suggestedBaseUrl={suggestedTautulliUrl}
        />
      )}
    </div>
  );
}
