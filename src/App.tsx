import { useMemo } from "react";
import { useSettings } from "./hooks/useSettings";
import { SettingsPanel } from "./components/SettingsPanel";
import { ServiceSection } from "./components/ServiceSection";
import { CATEGORY_ORDER } from "./types";

export default function App() {
  const {
    settings,
    showSettings,
    setShowSettings,
    updateService,
    updateTitle,
    updateSubtitle,
    setConnectionMode,
    resetSettings,
  } = useSettings();

  const servicesByCategory = useMemo(() => {
    const enabled = settings.services.filter((s) => s.enabled);
    return CATEGORY_ORDER.map((category) => ({
      category,
      services: enabled.filter((s) => s.category === category),
    })).filter((group) => group.services.length > 0);
  }, [settings.services]);

  const enabledCount = settings.services.filter((s) => s.enabled).length;

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
            <div className="connection-toggle" role="group" aria-label="Connection mode">
              <button
                type="button"
                className={`connection-btn${settings.connectionMode === "home" ? " active" : ""}`}
                onClick={() => setConnectionMode("home")}
              >
                🏠 Home
              </button>
              <button
                type="button"
                className={`connection-btn${settings.connectionMode === "remote" ? " active" : ""}`}
                onClick={() => setConnectionMode("remote")}
              >
                🌐 Remote
              </button>
            </div>
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
              connectionMode={settings.connectionMode}
            />
          ))
        )}
      </main>

      <footer className="footer">
        <span>
          {enabledCount} services ·{" "}
          {settings.connectionMode === "home" ? "Home network" : "Remote access"}
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
    </div>
  );
}
