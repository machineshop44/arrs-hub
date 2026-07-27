import type { AppSettings, ServiceConfig } from "../types";

interface SettingsPanelProps {
  settings: AppSettings;
  onClose: () => void;
  onUpdateService: (id: string, updates: Partial<ServiceConfig>) => void;
  onUpdateTitle: (title: string) => void;
  onUpdateSubtitle: (subtitle: string) => void;
  onReset: () => void;
}

export function SettingsPanel({
  settings,
  onClose,
  onUpdateService,
  onUpdateTitle,
  onUpdateSubtitle,
  onReset,
}: SettingsPanelProps) {
  return (
    <div className="settings-overlay" onClick={onClose} role="presentation">
      <div
        className="settings-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="settings-title"
        aria-modal="true"
      >
        <header className="settings-header">
          <h2 id="settings-title">Settings</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close settings">
            ✕
          </button>
        </header>

        <div className="settings-body">
          <section className="settings-group">
            <h3>Dashboard</h3>
            <label className="field">
              <span>Title</span>
              <input
                type="text"
                value={settings.title}
                onChange={(e) => onUpdateTitle(e.target.value)}
              />
            </label>
            <label className="field">
              <span>Subtitle</span>
              <input
                type="text"
                value={settings.subtitle}
                onChange={(e) => onUpdateSubtitle(e.target.value)}
              />
            </label>
          </section>

          <section className="settings-group">
            <h3>Services</h3>
            <p className="settings-hint">
              For each app, enter your home network address and optional remote
              address. Use the Home / Remote toggle on the dashboard to switch
              which links open.
            </p>
            <div className="settings-services">
              {settings.services.map((service) => (
                <div key={service.id} className="settings-service-row">
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={service.enabled}
                      onChange={(e) =>
                        onUpdateService(service.id, { enabled: e.target.checked })
                      }
                    />
                    <span className="toggle-label">
                      {service.icon} {service.name}
                    </span>
                  </label>
                  <label className="field">
                    <span>Home (local IP &amp; port)</span>
                    <input
                      type="text"
                      className="url-input"
                      value={service.homeUrl}
                      placeholder="http://192.168.1.50:8989"
                      disabled={!service.enabled}
                      onChange={(e) =>
                        onUpdateService(service.id, { homeUrl: e.target.value })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>Remote (optional)</span>
                    <input
                      type="text"
                      className="url-input"
                      value={service.remoteUrl}
                      placeholder="https://sonarr.yourdomain.com"
                      disabled={!service.enabled}
                      onChange={(e) =>
                        onUpdateService(service.id, { remoteUrl: e.target.value })
                      }
                    />
                  </label>
                </div>
              ))}
            </div>
          </section>
        </div>

        <footer className="settings-footer">
          <button type="button" className="btn btn-secondary" onClick={onReset}>
            Reset to defaults
          </button>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
