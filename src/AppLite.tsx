import { useMemo } from "react";
import { useSettings } from "./hooks/useSettings";
import { useServiceHealth } from "./hooks/useServiceHealth";
import { SettingsPanel } from "./components/SettingsPanel";
import { WatchdogPanel } from "./components/WatchdogPanel";
import { APP_VERSION_LABEL } from "./version";

export default function AppLite() {
  const {
    settings,
    showSettings,
    setShowSettings,
    updateService,
    updateTitle,
    updateSubtitle,
    resetSettings,
  } = useSettings();

  const watchdog = useServiceHealth(settings.services, "home");

  const serviceNames = useMemo(
    () =>
      settings.services.map((service) => ({
        id: service.id,
        name: service.name,
        enabled: service.enabled,
      })),
    [settings.services],
  );

  const upCount = Object.values(watchdog.health).filter(
    (item) => item.up === true,
  ).length;
  const downCount = Object.values(watchdog.health).filter(
    (item) => item.up === false,
  ).length;
  const pcsOnline = Object.values(watchdog.pcs).filter(
    (item) => item.online === true,
  ).length;
  const pcsOffline = Object.values(watchdog.pcs).filter(
    (item) => item.online === false,
  ).length;

  return (
    <div className="app app-lite">
      <header className="header">
        <div className="header-content">
          <div className="header-brand">
            <div className="logo">📥</div>
            <div>
              <h1>{settings.title}</h1>
              <p>{settings.subtitle}</p>
            </div>
          </div>
          <div className="header-actions">
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

      <main className="main main-lite">
        {(watchdog.serverUp || watchdog.scanning || watchdog.serverUp === null) && (
          <div className="watchdog-bar">
            <div>
              <strong>Port watch</strong>
              {watchdog.scanning || watchdog.serverUp === null ? (
                <span className="port-scan-status" role="status" aria-live="polite">
                  <span className="port-scan-spinner" aria-hidden="true" />
                  Checking qBit &amp; SAB…
                </span>
              ) : (
                <span>
                  {upCount} up · {downCount} down
                  {watchdog.pcCount > 0
                    ? ` · PCs ${pcsOnline} online / ${pcsOffline} offline`
                    : ""}
                  {watchdog.autoRestart ? " · auto-restart on" : " · auto-restart off"}
                </span>
              )}
              <small>
                Monitors qBittorrent and SABnzbd on this downloader PC. Add a
                secondary PC under Wake-on-LAN to turn on your Plex box from
                mobile via this hub.
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
                  disabled={watchdog.serverUp !== true}
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
              <span>Hub API offline — restart Arrs Hub Lite.</span>
            </div>
          </div>
        )}

        <WatchdogPanel
          embedded
          lite
          onClose={() => undefined}
          serviceNames={serviceNames}
        />
      </main>

      <footer className="footer">
        <span>
          {APP_VERSION_LABEL}
          {watchdog.scanning ? " · Searching ports…" : ""}
          {watchdog.serverUp === false ? " · Watchdog server offline" : ""}
        </span>
      </footer>

      {showSettings && (
        <SettingsPanel
          liteMode
          settings={settings}
          onClose={() => setShowSettings(false)}
          onUpdateService={updateService}
          onUpdateTitle={updateTitle}
          onUpdateSubtitle={updateSubtitle}
          onReset={resetSettings}
        />
      )}
    </div>
  );
}
