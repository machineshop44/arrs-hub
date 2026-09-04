import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { AppSettings, ServiceConfig } from "../types";
import { getServiceUrl } from "../types";
import type {
  PcLiveStatus,
  PcWatchConfig,
  ServiceWatchConfig,
  WatchdogSettings,
} from "./WatchdogPanel";

const ARR_API_IDS = new Set([
  "sonarr",
  "radarr",
  "lidarr",
  "readarr",
  "prowlarr",
  "bazarr",
  "whisparr",
]);

const API_KEY_APP_IDS = new Set([
  ...ARR_API_IDS,
  "sabnzbd",
  "ombi",
  "tautulli",
]);

const EXE_PLACEHOLDERS: Record<string, string> = {
  plex: "C:\\Program Files\\Plex\\Plex Media Server\\Plex Media Server.exe",
  qbittorrent: "C:\\Program Files\\qBittorrent\\qbittorrent.exe",
  sabnzbd: "C:\\Program Files\\SABnzbd\\SABnzbd.exe",
  ombi: "C:\\Program Files\\Ombi\\Ombi.exe",
  flaresolverr: "C:\\Program Files\\FlareSolverr\\FlareSolverr.exe",
  ytarr: "C:\\Users\\…\\AppData\\Local\\Programs\\ytarr\\ytarr.exe",
};

function newPcId() {
  return `pc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function emptyPc(): PcWatchConfig {
  return {
    id: newPcId(),
    name: "",
    host: "",
    mac: "",
    monitor: true,
    wakeOnLan: true,
    companionUrl: "",
    companionApiKey: "",
  };
}

interface AppsMonitoringSectionProps {
  settings: AppSettings;
  onUpdateService: (id: string, updates: Partial<ServiceConfig>) => void;
  serverUp: boolean | null;
  onOpenStreams?: () => void;
}

export type AppsMonitoringHandle = {
  /** Persist any pasted API keys before Settings closes. */
  flushCredentials: () => Promise<void>;
};

export const AppsMonitoringSection = forwardRef<
  AppsMonitoringHandle,
  AppsMonitoringSectionProps
>(function AppsMonitoringSection(
  { settings, onUpdateService, serverUp, onOpenStreams },
  ref,
) {
  const [watchdog, setWatchdog] = useState<WatchdogSettings | null>(null);
  const [pcStatus, setPcStatus] = useState<Record<string, PcLiveStatus>>({});
  const [arrKeys, setArrKeys] = useState<Record<string, string>>({});
  const [arrKeySet, setArrKeySet] = useState<Record<string, boolean>>({});
  const [qbUser, setQbUser] = useState("");
  const [qbPass, setQbPass] = useState("");
  const [qbPassSet, setQbPassSet] = useState(false);
  const [appApiKeys, setAppApiKeys] = useState<Record<string, string>>({});
  const [appApiKeySet, setAppApiKeySet] = useState<Record<string, boolean>>(
    {},
  );
  const [tautulliKey, setTautulliKey] = useState("");
  const [tautulliKeySet, setTautulliKeySet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [wakingId, setWakingId] = useState<string | null>(null);
  const [message, setMessage] = useState<{
    type: "ok" | "err";
    text: string;
  } | null>(null);

  const draftRef = useRef({
    arrKeys,
    appApiKeys,
    tautulliKey,
    qbUser,
    qbPass,
  });
  draftRef.current = { arrKeys, appApiKeys, tautulliKey, qbUser, qbPass };

  const hubUrl = useCallback(
    (id: string) => {
      const service = settings.services.find((s) => s.id === id);
      if (!service) return "";
      return (
        getServiceUrl(service, "home") || service.homeUrl || service.defaultUrl
      );
    },
    [settings.services],
  );

  const applyWatchdog = (json: {
    settings?: WatchdogSettings;
    pcs?: Record<string, PcLiveStatus>;
  }) => {
    if (json.settings) {
      const pcs = Array.isArray(json.settings.pcs)
        ? json.settings.pcs.map((pc) => ({ ...pc, companionApiKey: "" }))
        : [];
      setWatchdog({ ...json.settings, pcs });
    }
    setPcStatus(json.pcs ?? {});
  };

  const applyCredentialFlags = (opts: {
    arr?: Record<string, { apiKeySet?: boolean }>;
    integrations?: {
      qbittorrent?: { passwordSet?: boolean; username?: string };
      sabnzbd?: { apiKeySet?: boolean };
      ombi?: { apiKeySet?: boolean };
    };
    tautulliKeySet?: boolean;
  }) => {
    if (opts.arr) {
      const keySet: Record<string, boolean> = {};
      for (const [id, cfg] of Object.entries(opts.arr)) {
        keySet[id] = Boolean(cfg?.apiKeySet);
      }
      setArrKeySet((prev) => ({ ...prev, ...keySet }));
    }
    if (opts.integrations) {
      if (opts.integrations.qbittorrent) {
        setQbPassSet(Boolean(opts.integrations.qbittorrent.passwordSet));
        if (opts.integrations.qbittorrent.username) {
          setQbUser(opts.integrations.qbittorrent.username);
        }
      }
      setAppApiKeySet((prev) => ({
        ...prev,
        sabnzbd: Boolean(opts.integrations?.sabnzbd?.apiKeySet ?? prev.sabnzbd),
        ombi: Boolean(opts.integrations?.ombi?.apiKeySet ?? prev.ombi),
      }));
    }
    if (opts.tautulliKeySet !== undefined) {
      setTautulliKeySet(opts.tautulliKeySet);
    }
  };

  /**
   * Persist API keys / download creds. Safe to call on paste debounce or Done.
   * Blank fields keep whatever was already saved.
   */
  const persistCredentials = useCallback(
    async (opts?: { silent?: boolean; clearDrafts?: boolean }) => {
      if (serverUp === false) return;
      const draft = draftRef.current;
      const hasArrDraft = [...ARR_API_IDS].some((id) =>
        String(draft.arrKeys[id] || "").trim(),
      );
      const hasAppDraft =
        String(draft.appApiKeys.sabnzbd || "").trim() ||
        String(draft.appApiKeys.ombi || "").trim() ||
        String(draft.tautulliKey || "").trim() ||
        String(draft.qbPass || "").trim() ||
        Boolean(String(draft.qbUser || "").trim());

      // Always push *arr keys (empty = keep) so URLs/baseUrl stay in sync when saving.
      // Skip network if literally nothing to write and silent.
      if (opts?.silent && !hasArrDraft && !hasAppDraft) return;

      const arrPatch: Record<string, string> = {};
      for (const id of ARR_API_IDS) {
        arrPatch[id] = draft.arrKeys[id] || "";
      }
      const arrRes = await fetch("/api/arr/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(arrPatch),
      });
      const arrJson = await arrRes.json();
      if (!arrRes.ok) {
        throw new Error(arrJson.error || "API key save failed");
      }

      const syncRes = await fetch("/api/sync/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sonarr: {
            apiKey: draft.arrKeys.sonarr || "",
            baseUrl: hubUrl("sonarr"),
          },
          radarr: {
            apiKey: draft.arrKeys.radarr || "",
            baseUrl: hubUrl("radarr"),
          },
        }),
      });
      if (!syncRes.ok) {
        const syncJson = await syncRes.json().catch(() => ({}));
        throw new Error(
          (syncJson as { error?: string }).error || "Sync settings save failed",
        );
      }

      const intRes = await fetch("/api/integrations/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          qbittorrent: {
            baseUrl: hubUrl("qbittorrent"),
            username: draft.qbUser,
            password: draft.qbPass,
          },
          sabnzbd: {
            baseUrl: hubUrl("sabnzbd"),
            apiKey: draft.appApiKeys.sabnzbd || "",
          },
          ombi: {
            baseUrl: hubUrl("ombi"),
            apiKey: draft.appApiKeys.ombi || "",
          },
        }),
      });
      const intJson = await intRes.json();
      if (!intRes.ok) {
        throw new Error(intJson.error || "Integrations save failed");
      }

      if (
        settings.services.some((s) => s.id === "tautulli" && s.enabled) ||
        String(draft.tautulliKey || "").trim()
      ) {
        const tautRes = await fetch("/api/tautulli/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            baseUrl: hubUrl("tautulli") || "http://localhost:8181",
            apiKey: draft.tautulliKey,
          }),
        });
        const tautJson = await tautRes.json();
        if (!tautRes.ok) {
          throw new Error(tautJson.error || "Tautulli save failed");
        }
        applyCredentialFlags({
          tautulliKeySet: Boolean(tautJson.settings?.apiKeySet),
        });
      }

      applyCredentialFlags({
        arr: arrJson.credentials,
        integrations: intJson.settings,
      });

      if (opts?.clearDrafts) {
        setArrKeys({});
        setAppApiKeys({});
        setTautulliKey("");
        setQbPass("");
      }

      if (!opts?.silent) {
        setMessage({
          type: "ok",
          text: "API keys saved on this PC.",
        });
      }
    },
    [hubUrl, serverUp, settings.services],
  );

  useImperativeHandle(
    ref,
    () => ({
      flushCredentials: async () => {
        try {
          await persistCredentials({ silent: true, clearDrafts: true });
        } catch {
          // Closing Settings — don't block; user can re-open if save failed.
        }
      },
    }),
    [persistCredentials],
  );

  // Auto-save shortly after paste / typing so closing Settings still keeps keys.
  useEffect(() => {
    const draft = draftRef.current;
    const hasDraft =
      [...ARR_API_IDS].some((id) => String(draft.arrKeys[id] || "").trim()) ||
      String(draft.appApiKeys.sabnzbd || "").trim() ||
      String(draft.appApiKeys.ombi || "").trim() ||
      String(draft.tautulliKey || "").trim() ||
      String(draft.qbPass || "").trim();
    if (!hasDraft || serverUp === false) return;
    const timer = setTimeout(() => {
      void persistCredentials({ silent: true }).catch((err) => {
        setMessage({
          type: "err",
          text:
            err instanceof Error
              ? err.message
              : "Could not auto-save API keys",
        });
      });
    }, 700);
    return () => clearTimeout(timer);
  }, [arrKeys, appApiKeys, tautulliKey, qbPass, persistCredentials, serverUp]);

  const load = useCallback(async () => {
    if (serverUp === false) return;
    try {
      const [watchRes, arrRes, intRes, tautRes] = await Promise.all([
        fetch("/api/watchdog/status"),
        fetch("/api/arr/credentials"),
        fetch("/api/integrations/settings"),
        fetch("/api/tautulli/settings"),
      ]);
      const watchJson = await watchRes.json();
      const arrJson = await arrRes.json();
      const intJson = await intRes.json();
      const tautJson = await tautRes.json();

      if (watchRes.ok) applyWatchdog(watchJson);

      const keySet: Record<string, boolean> = {};
      for (const [id, cfg] of Object.entries(
        arrJson.credentials ?? {},
      ) as [string, { apiKeySet?: boolean }][]) {
        keySet[id] = Boolean(cfg.apiKeySet);
      }
      setArrKeySet(keySet);
      // Don't wipe in-progress drafts if the user is mid-paste.
      const draft = draftRef.current;
      const typing = [...ARR_API_IDS].some((id) =>
        String(draft.arrKeys[id] || "").trim(),
      );
      if (!typing) setArrKeys({});

      setQbUser(intJson.settings?.qbittorrent?.username || "");
      if (!String(draft.qbPass || "").trim()) setQbPass("");
      setQbPassSet(Boolean(intJson.settings?.qbittorrent?.passwordSet));

      const integrationKeySet: Record<string, boolean> = {};
      for (const id of ["sabnzbd", "ombi"] as const) {
        integrationKeySet[id] = Boolean(intJson.settings?.[id]?.apiKeySet);
      }
      setAppApiKeySet((prev) => ({ ...prev, ...integrationKeySet }));
      if (
        !String(draft.appApiKeys.sabnzbd || "").trim() &&
        !String(draft.appApiKeys.ombi || "").trim()
      ) {
        setAppApiKeys({});
      }

      setTautulliKeySet(Boolean(tautJson.settings?.apiKeySet));
      if (!String(draft.tautulliKey || "").trim()) setTautulliKey("");
    } catch {
      // parent shows server offline
    }
  }, [serverUp]);

  useEffect(() => {
    void load();
  }, [load]);

  const updateServiceWatch = (
    id: string,
    patch: Partial<ServiceWatchConfig>,
  ) => {
    setWatchdog((prev) => {
      if (!prev) return prev;
      const current = prev.services[id] ?? {
        monitor: true,
        autoRestart: false,
        windowsService: "",
        exePath: "",
        restartPcId: "",
      };
      return {
        ...prev,
        services: { ...prev.services, [id]: { ...current, ...patch } },
      };
    });
  };

  const updatePc = (id: string, patch: Partial<PcWatchConfig>) => {
    setWatchdog((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        pcs: prev.pcs.map((pc) => (pc.id === id ? { ...pc, ...patch } : pc)),
      };
    });
  };

  const removePc = (id: string) => {
    setWatchdog((prev) => {
      if (!prev) return prev;
      return { ...prev, pcs: prev.pcs.filter((pc) => pc.id !== id) };
    });
  };

  const addPc = () => {
    setWatchdog((prev) => {
      if (!prev) return prev;
      return { ...prev, pcs: [...prev.pcs, emptyPc()] };
    });
  };

  const wakeNow = async (pcId: string) => {
    setWakingId(pcId);
    setMessage(null);
    try {
      const res = await fetch("/api/watchdog/wol", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pcId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Wake failed");
      applyWatchdog(json);
      setMessage({
        type: "ok",
        text: json.message || `Wake packet sent for ${json.pc || "PC"}.`,
      });
    } catch (err) {
      setMessage({
        type: "err",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setWakingId(null);
    }
  };

  const saveAll = async () => {
    setBusy(true);
    setMessage(null);
    try {
      // Keys first — never lose pasted API keys if watchdog save fails.
      await persistCredentials({ silent: true, clearDrafts: true });

      if (!watchdog) {
        setMessage({
          type: "ok",
          text: "API keys saved on this PC.",
        });
        return;
      }

      const watchRes = await fetch("/api/watchdog/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: watchdog.enabled,
          intervalSeconds: watchdog.intervalSeconds,
          failThreshold: watchdog.failThreshold,
          startupGraceSeconds: watchdog.startupGraceSeconds ?? 120,
          restartCooldownSeconds: watchdog.restartCooldownSeconds,
          autoRestart: watchdog.autoRestart,
          wolEnabled: watchdog.wolEnabled,
          wolCooldownSeconds: watchdog.wolCooldownSeconds,
          services: watchdog.services,
          pcs: watchdog.pcs,
        }),
      });
      const watchJson = await watchRes.json();
      if (!watchRes.ok) throw new Error(watchJson.error || "Watchdog save failed");
      applyWatchdog(watchJson);

      await load();
      setMessage({
        type: "ok",
        text: "Apps & monitoring settings saved on this PC.",
      });
    } catch (err) {
      setMessage({
        type: "err",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const apps = settings.services.filter((s) => s.id !== "trash-guides");

  const onlineLabel = (status: PcLiveStatus | undefined) => {
    if (!status || status.online === null || status.online === undefined) {
      return { text: "Unknown", className: "pc-status pc-status-unknown" };
    }
    if (status.online) {
      return { text: "Online", className: "pc-status pc-status-online" };
    }
    return { text: "Offline", className: "pc-status pc-status-offline" };
  };

  const apiKeyValue = (id: string) => {
    if (id === "tautulli") return tautulliKey;
    if (ARR_API_IDS.has(id)) return arrKeys[id] || "";
    return appApiKeys[id] || "";
  };

  const apiKeySet = (id: string) => {
    if (id === "tautulli") return tautulliKeySet;
    if (ARR_API_IDS.has(id)) return arrKeySet[id];
    return appApiKeySet[id];
  };

  const setApiKeyValue = (id: string, value: string) => {
    if (id === "tautulli") setTautulliKey(value);
    else if (ARR_API_IDS.has(id))
      setArrKeys((prev) => ({ ...prev, [id]: value }));
    else setAppApiKeys((prev) => ({ ...prev, [id]: value }));
  };

  return (
    <section className="settings-group" id="apps-monitoring">
      <h3>Apps &amp; monitoring</h3>
      <p className="settings-hint">
        One place for each app&apos;s URLs, API keys (dashboard chips, update
        checks, TRaSH Sync), and port watch / restart. API keys auto-save a
        moment after you paste them (and again when you click Done). Home vs
        Remote links use your header Auto/Home/Remote mode on the dashboard.
      </p>

      {serverUp === false && (
        <p className="settings-hint">
          Hub API is offline — start the hub server to save monitoring settings.
        </p>
      )}

      {serverUp && watchdog && (
        <>
          <div className="apps-monitor-global">
            <label className="toggle">
              <input
                type="checkbox"
                checked={watchdog.enabled}
                onChange={(e) =>
                  setWatchdog((prev) =>
                    prev ? { ...prev, enabled: e.target.checked } : prev,
                  )
                }
              />
              <span className="toggle-label">Enable port monitoring</span>
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={watchdog.autoRestart}
                onChange={(e) =>
                  setWatchdog((prev) =>
                    prev ? { ...prev, autoRestart: e.target.checked } : prev,
                  )
                }
              />
              <span className="toggle-label">Allow auto-restart (global)</span>
            </label>
            <label className="field">
              <span>Check every (seconds)</span>
              <input
                type="number"
                min={10}
                max={600}
                value={watchdog.intervalSeconds}
                onChange={(e) =>
                  setWatchdog((prev) =>
                    prev
                      ? {
                          ...prev,
                          intervalSeconds: Number(e.target.value) || 30,
                        }
                      : prev,
                  )
                }
              />
            </label>
            <label className="field">
              <span>Failed checks before restart</span>
              <input
                type="number"
                min={1}
                max={10}
                value={watchdog.failThreshold}
                onChange={(e) =>
                  setWatchdog((prev) =>
                    prev
                      ? {
                          ...prev,
                          failThreshold: Number(e.target.value) || 2,
                        }
                      : prev,
                  )
                }
              />
            </label>
            <label className="field">
              <span>Startup wait before restart (seconds)</span>
              <input
                type="number"
                min={0}
                max={600}
                value={watchdog.startupGraceSeconds ?? 120}
                onChange={(e) =>
                  setWatchdog((prev) =>
                    prev
                      ? {
                          ...prev,
                          startupGraceSeconds: Number(e.target.value) || 0,
                        }
                      : prev,
                  )
                }
              />
            </label>
          </div>

          <div className="sync-presets apps-monitor-cards">
            {apps.map((service) => {
              const cfg = watchdog.services[service.id] ?? {
                monitor: true,
                autoRestart: false,
                windowsService: "",
                exePath: "",
                restartPcId: "",
              };
              const showApiKey = API_KEY_APP_IDS.has(service.id);
              const showQbitCreds = service.id === "qbittorrent";

              return (
                <div key={service.id} className="app-config-card">
                  <div className="app-config-card-header">
                    <label className="toggle">
                      <input
                        type="checkbox"
                        checked={service.enabled}
                        onChange={(e) =>
                          onUpdateService(service.id, {
                            enabled: e.target.checked,
                          })
                        }
                      />
                      <span className="toggle-label">
                        <img
                          className="settings-service-icon"
                          src={service.icon}
                          alt={service.name}
                          width={20}
                          height={20}
                          draggable={false}
                        />{" "}
                        {service.name}
                      </span>
                    </label>
                  </div>

                  <label className="field">
                    <span>Home (local IP &amp; port)</span>
                    <input
                      type="text"
                      className="url-input"
                      value={service.homeUrl}
                      placeholder="http://192.168.1.50:8989"
                      disabled={!service.enabled}
                      onChange={(e) =>
                        onUpdateService(service.id, {
                          homeUrl: e.target.value,
                        })
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
                        onUpdateService(service.id, {
                          remoteUrl: e.target.value,
                        })
                      }
                    />
                  </label>

                  {showApiKey && service.enabled && (
                    <label className="field">
                      <span>
                        API key
                        {apiKeySet(service.id)
                          ? " (saved — leave blank to keep)"
                          : ""}
                        {service.id === "tautulli" && onOpenStreams ? (
                          <>
                            {" · "}
                            <button
                              type="button"
                              className="btn btn-ghost apps-inline-link"
                              onClick={onOpenStreams}
                            >
                              Open Streams
                            </button>
                          </>
                        ) : null}
                      </span>
                      <input
                        type="password"
                        autoComplete="off"
                        placeholder={
                          apiKeySet(service.id)
                            ? "•••• saved ••••"
                            : "Paste API key"
                        }
                        value={apiKeyValue(service.id)}
                        disabled={busy}
                        onChange={(e) =>
                          setApiKeyValue(service.id, e.target.value)
                        }
                      />
                    </label>
                  )}

                  {showQbitCreds && service.enabled && (
                    <>
                      <label className="field">
                        <span>qBittorrent username</span>
                        <input
                          type="text"
                          autoComplete="off"
                          value={qbUser}
                          disabled={busy}
                          onChange={(e) => setQbUser(e.target.value)}
                        />
                      </label>
                      <label className="field">
                        <span>
                          qBittorrent password
                          {qbPassSet ? " (saved — leave blank to keep)" : ""}
                        </span>
                        <input
                          type="password"
                          autoComplete="off"
                          placeholder={
                            qbPassSet ? "•••• saved ••••" : "Password"
                          }
                          value={qbPass}
                          disabled={busy}
                          onChange={(e) => setQbPass(e.target.value)}
                        />
                      </label>
                    </>
                  )}

                  {service.enabled && (
                    <details className="app-config-port-watch">
                      <summary>Port watch &amp; restart</summary>
                      <label className="toggle">
                        <input
                          type="checkbox"
                          checked={cfg.monitor}
                          onChange={(e) =>
                            updateServiceWatch(service.id, {
                              monitor: e.target.checked,
                            })
                          }
                        />
                        <span className="toggle-label">Monitor port</span>
                      </label>
                      <label className="toggle">
                        <input
                          type="checkbox"
                          checked={cfg.autoRestart}
                          onChange={(e) =>
                            updateServiceWatch(service.id, {
                              autoRestart: e.target.checked,
                            })
                          }
                        />
                        <span className="toggle-label">Auto-restart</span>
                      </label>
                      <label className="field">
                        <span>Windows service name</span>
                        <input
                          type="text"
                          value={cfg.windowsService}
                          placeholder="e.g. Sonarr"
                          onChange={(e) =>
                            updateServiceWatch(service.id, {
                              windowsService: e.target.value,
                            })
                          }
                        />
                      </label>
                      <label className="field">
                        <span>Exe path (fallback)</span>
                        <input
                          type="text"
                          value={cfg.exePath}
                          placeholder={
                            EXE_PLACEHOLDERS[service.id] ??
                            "C:\\ProgramData\\App\\bin\\App.exe"
                          }
                          onChange={(e) =>
                            updateServiceWatch(service.id, {
                              exePath: e.target.value,
                            })
                          }
                        />
                      </label>
                      <label className="field">
                        <span>Restart on</span>
                        <select
                          value={cfg.restartPcId || ""}
                          onChange={(e) =>
                            updateServiceWatch(service.id, {
                              restartPcId: e.target.value,
                            })
                          }
                        >
                          <option value="">This PC (Plex hub)</option>
                          {watchdog.pcs
                            .filter((pc) => pc.companionUrl?.trim())
                            .map((pc) => (
                              <option key={pc.id} value={pc.id}>
                                Companion —{" "}
                                {pc.name.trim() || pc.host || pc.id}
                              </option>
                            ))}
                        </select>
                      </label>
                    </details>
                  )}
                </div>
              );
            })}
          </div>

          <section className="settings-subgroup">
            <h4>PC power &amp; Wake-on-LAN</h4>
            <p className="settings-hint">
              Install <strong>Arrs Hub Companion</strong> on your downloader PC
              for LAN restarts. Manual fields below are optional overrides.
            </p>
            <label className="toggle">
              <input
                type="checkbox"
                checked={watchdog.wolEnabled}
                onChange={(e) =>
                  setWatchdog((prev) =>
                    prev ? { ...prev, wolEnabled: e.target.checked } : prev,
                  )
                }
              />
              <span className="toggle-label">Enable Wake-on-LAN</span>
            </label>
            <label className="field">
              <span>WOL cooldown (seconds)</span>
              <input
                type="number"
                min={30}
                max={3600}
                value={watchdog.wolCooldownSeconds}
                onChange={(e) =>
                  setWatchdog((prev) =>
                    prev
                      ? {
                          ...prev,
                          wolCooldownSeconds: Number(e.target.value) || 300,
                        }
                      : prev,
                  )
                }
              />
            </label>

            <div className="sync-presets">
              {watchdog.pcs.length === 0 && (
                <p className="settings-hint">
                  No PCs yet. Add one with a local IP/hostname and MAC.
                </p>
              )}
              {watchdog.pcs.map((pc) => {
                const live = pcStatus[pc.id];
                const status = onlineLabel(live);
                return (
                  <div
                    key={pc.id}
                    className="watchdog-service-row watchdog-pc-row"
                  >
                    <div className="watchdog-pc-header">
                      <strong>{pc.name.trim() || "Unnamed PC"}</strong>
                      <span className={status.className}>{status.text}</span>
                    </div>
                    {live?.message && (
                      <p className="settings-hint watchdog-pc-message">
                        {live.message}
                      </p>
                    )}
                    <label className="field">
                      <span>Name</span>
                      <input
                        type="text"
                        value={pc.name}
                        placeholder="Living room PC"
                        onChange={(e) =>
                          updatePc(pc.id, { name: e.target.value })
                        }
                      />
                    </label>
                    <label className="field">
                      <span>Host / IP</span>
                      <input
                        type="text"
                        value={pc.host}
                        placeholder="192.168.1.50"
                        onChange={(e) =>
                          updatePc(pc.id, { host: e.target.value })
                        }
                      />
                    </label>
                    <label className="field">
                      <span>MAC address</span>
                      <input
                        type="text"
                        value={pc.mac}
                        placeholder="AA:BB:CC:DD:EE:FF"
                        onChange={(e) =>
                          updatePc(pc.id, { mac: e.target.value })
                        }
                      />
                    </label>
                    <label className="field">
                      <span>Companion URL (optional)</span>
                      <input
                        type="text"
                        value={pc.companionUrl || ""}
                        placeholder="http://192.168.1.50:3901"
                        onChange={(e) =>
                          updatePc(pc.id, { companionUrl: e.target.value })
                        }
                      />
                    </label>
                    <label className="field">
                      <span>
                        Companion API key
                        {pc.companionApiKeySet
                          ? " (saved — leave blank to keep)"
                          : ""}
                      </span>
                      <input
                        type="password"
                        autoComplete="off"
                        placeholder={
                          pc.companionApiKeySet
                            ? "•••• saved ••••"
                            : "Paste from Companion tray"
                        }
                        value={pc.companionApiKey || ""}
                        onChange={(e) =>
                          updatePc(pc.id, {
                            companionApiKey: e.target.value,
                          })
                        }
                      />
                    </label>
                    <label className="toggle">
                      <input
                        type="checkbox"
                        checked={pc.monitor}
                        onChange={(e) =>
                          updatePc(pc.id, { monitor: e.target.checked })
                        }
                      />
                      <span className="toggle-label">Monitor online</span>
                    </label>
                    <label className="toggle">
                      <input
                        type="checkbox"
                        checked={pc.wakeOnLan}
                        onChange={(e) =>
                          updatePc(pc.id, { wakeOnLan: e.target.checked })
                        }
                      />
                      <span className="toggle-label">Auto Wake-on-LAN</span>
                    </label>
                    <div className="watchdog-pc-actions">
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={wakingId === pc.id || !pc.mac.trim()}
                        onClick={() => void wakeNow(pc.id)}
                      >
                        {wakingId === pc.id ? "Waking…" : "Wake now"}
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => removePc(pc.id)}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            <button type="button" className="btn btn-secondary" onClick={addPc}>
              Add PC
            </button>
          </section>

          {message && (
            <div
              className={`sync-alert ${message.type === "ok" ? "sync-alert-ok" : "sync-alert-err"}`}
            >
              {message.text}
            </div>
          )}

          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !serverUp}
            onClick={() => void saveAll()}
          >
            {busy ? "Saving…" : "Save apps & monitoring"}
          </button>
        </>
      )}
    </section>
  );
});
