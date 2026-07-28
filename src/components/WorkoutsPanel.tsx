import { useCallback, useEffect, useMemo, useState } from "react";

type WorkoutSettings = {
  plexBaseUrl: string;
  plexToken: string;
  plexTokenSet?: boolean;
  librarySectionId: string;
  matchMode: "episode" | "title";
  showTitle: string;
  seasonNumber: number;
  warmupEpisode: number;
  firstDayEpisode: number;
  warmupTitle: string;
  dayTitlePattern: string;
  clientMachineId: string;
  clientName: string;
  dayCount: number;
};

type Library = { id: string; title: string; type: string };
type Client = {
  name: string;
  address: string;
  port: number;
  machineIdentifier: string;
  product?: string;
};
type DayItem = { day: number; title: string; ratingKey: string };

interface WorkoutsPanelProps {
  onClose: () => void;
  suggestedPlexUrl?: string;
}

export function WorkoutsPanel({
  onClose,
  suggestedPlexUrl,
}: WorkoutsPanelProps) {
  const [settings, setSettings] = useState<WorkoutSettings | null>(null);
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [days, setDays] = useState<DayItem[]>([]);
  const [warmup, setWarmup] = useState<{
    title: string;
    ratingKey: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [playingDay, setPlayingDay] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [serverUp, setServerUp] = useState<boolean | null>(null);
  const [showSetup, setShowSetup] = useState(false);

  const configured = Boolean(
    settings?.plexTokenSet &&
      settings.librarySectionId &&
      settings.clientMachineId,
  );

  const loadSettings = useCallback(async () => {
    let healthOk = false;
    try {
      const health = await fetch("/api/health");
      healthOk = health.ok;
    } catch {
      healthOk = false;
    }
    setServerUp(healthOk);
    if (!healthOk) return null;

    const res = await fetch("/api/workouts/settings");
    const text = await res.text();
    let json: { error?: string; settings?: WorkoutSettings } = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(
        "Workouts API not available. Stop the hub completely and start it again with start-hub.bat (or npm run dev) so the server reloads.",
      );
    }
    if (!res.ok) {
      throw new Error(json.error || "Failed to load workout settings");
    }
    const loaded = (json.settings || {}) as Partial<WorkoutSettings>;
    const next: WorkoutSettings = {
      plexBaseUrl: loaded.plexBaseUrl || "",
      plexToken: loaded.plexToken || "",
      plexTokenSet: loaded.plexTokenSet,
      librarySectionId: loaded.librarySectionId || "",
      matchMode: loaded.matchMode === "title" ? "title" : "episode",
      showTitle: loaded.showTitle || "Fit With the Force",
      seasonNumber: loaded.seasonNumber ?? 1,
      warmupEpisode: loaded.warmupEpisode ?? 2,
      firstDayEpisode: loaded.firstDayEpisode ?? 3,
      warmupTitle: loaded.warmupTitle || "Warm Up",
      dayTitlePattern: loaded.dayTitlePattern || "Day {n}",
      clientMachineId: loaded.clientMachineId || "",
      clientName: loaded.clientName || "",
      dayCount: loaded.dayCount || 30,
    };
    if (!next.plexBaseUrl && suggestedPlexUrl) {
      next.plexBaseUrl = suggestedPlexUrl;
    }
    setSettings(next);
    setShowSetup(
      !(next.plexTokenSet && next.librarySectionId && next.clientMachineId),
    );
    setError(null);
    return next;
  }, [suggestedPlexUrl]);

  const refreshMeta = useCallback(async () => {
    const [libRes, clientRes, discoverRes] = await Promise.all([
      fetch("/api/workouts/libraries"),
      fetch("/api/workouts/clients"),
      fetch("/api/workouts/discover"),
    ]);

    const readJson = async (res: Response) => {
      const text = await res.text();
      try {
        return text ? JSON.parse(text) : {};
      } catch {
        return {
          error:
            "Workouts API not available. Restart the hub with start-hub.bat.",
        };
      }
    };

    const libJson = await readJson(libRes);
    const clientJson = await readJson(clientRes);
    const discoverJson = await readJson(discoverRes);

    if (libRes.ok) setLibraries(libJson.libraries ?? []);
    else setLibraries([]);

    if (clientRes.ok) setClients(clientJson.clients ?? []);
    else setClients([]);

    if (discoverRes.ok) {
      setDays(discoverJson.days ?? []);
      setWarmup(discoverJson.warmup ?? null);
      setError(null);
      if (discoverJson.hint) setMessage(discoverJson.hint);
    } else {
      setDays([]);
      setWarmup(null);
      if (discoverJson.error) setError(discoverJson.error);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const loaded = await loadSettings();
        if (!loaded?.plexTokenSet) return;
        await refreshMeta();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [loadSettings, refreshMeta]);

  const dayButtons = useMemo(() => {
    const max = Math.max(
      settings?.dayCount || 30,
      ...days.map((d) => d.day),
      1,
    );
    return Array.from({ length: max }, (_, i) => {
      const day = i + 1;
      const found = days.find((item) => item.day === day);
      return { day, found };
    });
  }, [days, settings?.dayCount]);

  const save = async () => {
    if (!settings) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch("/api/workouts/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      setSettings(json.settings);
      setMessage("Workout settings saved.");
      await refreshMeta();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const playDay = async (day: number) => {
    setPlayingDay(day);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch("/api/workouts/play", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ day }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Play failed");
      setMessage(`Playing on ${json.client}: ${json.warmup} → ${json.day}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlayingDay(null);
    }
  };

  return (
    <div className="settings-overlay" onClick={onClose} role="presentation">
      <div
        className="settings-panel sync-panel workouts-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="workouts-title"
        aria-modal="true"
      >
        <header className="settings-header">
          <div>
            <h2 id="workouts-title">Workouts</h2>
            <p className="settings-hint">
              Pick a day — plays warm-up, then that day’s video on your Plex
              TV/stick.
            </p>
          </div>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="settings-body">
          {serverUp === false && (
            <div className="sync-alert sync-alert-err">
              Hub server offline. Start with <code>npm run dev</code> or{" "}
              <code>start-hub.bat</code>.
            </div>
          )}

          {settings && (
            <>
              <div className="workouts-toolbar">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setShowSetup((v) => !v)}
                >
                  {showSetup ? "Hide setup" : "Setup"}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy || !settings.plexTokenSet}
                  onClick={() => void refreshMeta()}
                >
                  Refresh
                </button>
              </div>

              {showSetup && (
                <section className="settings-group">
                  <h3>Plex connection</h3>
                  <p className="settings-hint">
                    Need a token?{" "}
                    <a
                      href="https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Find your X-Plex-Token
                    </a>
                    . Use the server URL without <code>/web</code> (example:{" "}
                    <code>http://localhost:32400</code>).
                  </p>
                  <label className="field">
                    <span>Plex server URL</span>
                    <input
                      value={settings.plexBaseUrl}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          plexBaseUrl: e.target.value,
                        })
                      }
                      placeholder="http://localhost:32400"
                    />
                  </label>
                  <label className="field">
                    <span>Plex token</span>
                    <input
                      value={settings.plexToken}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          plexToken: e.target.value,
                        })
                      }
                      placeholder={
                        settings.plexTokenSet
                          ? "Token saved — paste a new one to replace"
                          : "Paste X-Plex-Token"
                      }
                      autoComplete="off"
                    />
                  </label>
                  <label className="field">
                    <span>Match mode</span>
                    <select
                      value={settings.matchMode || "episode"}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          matchMode: e.target.value as "episode" | "title",
                        })
                      }
                    >
                      <option value="episode">
                        TV episodes (Fit With the Force)
                      </option>
                      <option value="title">Video titles (Day 1, Warm Up)</option>
                    </select>
                  </label>
                  {(settings.matchMode || "episode") === "episode" ? (
                    <>
                      <label className="field">
                        <span>Show title contains</span>
                        <input
                          value={settings.showTitle || ""}
                          onChange={(e) =>
                            setSettings({
                              ...settings,
                              showTitle: e.target.value,
                            })
                          }
                          placeholder="Fit With the Force"
                        />
                      </label>
                      <label className="field">
                        <span>Season number</span>
                        <input
                          type="number"
                          min={1}
                          max={50}
                          value={settings.seasonNumber ?? 1}
                          onChange={(e) =>
                            setSettings({
                              ...settings,
                              seasonNumber: Number(e.target.value) || 1,
                            })
                          }
                        />
                      </label>
                      <label className="field">
                        <span>Warm-up episode #</span>
                        <input
                          type="number"
                          min={1}
                          max={200}
                          value={settings.warmupEpisode ?? 2}
                          onChange={(e) =>
                            setSettings({
                              ...settings,
                              warmupEpisode: Number(e.target.value) || 2,
                            })
                          }
                        />
                      </label>
                      <label className="field">
                        <span>Day 1 episode #</span>
                        <input
                          type="number"
                          min={1}
                          max={200}
                          value={settings.firstDayEpisode ?? 3}
                          onChange={(e) =>
                            setSettings({
                              ...settings,
                              firstDayEpisode: Number(e.target.value) || 3,
                            })
                          }
                        />
                      </label>
                      <p className="settings-hint">
                        For <strong>Fit With the Force Series</strong> season 1:
                        episode 2 = warm-up, episode 3 = Day 1, episode 4 = Day
                        2, and so on. Pick the TV library that contains the
                        show.
                      </p>
                    </>
                  ) : (
                    <>
                      <label className="field">
                        <span>Warm-up title</span>
                        <input
                          value={settings.warmupTitle}
                          onChange={(e) =>
                            setSettings({
                              ...settings,
                              warmupTitle: e.target.value,
                            })
                          }
                          placeholder="Warm Up"
                        />
                      </label>
                      <label className="field">
                        <span>Day title pattern</span>
                        <input
                          value={settings.dayTitlePattern}
                          onChange={(e) =>
                            setSettings({
                              ...settings,
                              dayTitlePattern: e.target.value,
                            })
                          }
                          placeholder="Day {n}"
                        />
                      </label>
                      <p className="settings-hint">
                        Use <code>{"{n}"}</code> for 1, 2, 3 or{" "}
                        <code>{"{nn}"}</code> for 01, 02, 03. Titles only need to
                        contain that text.
                      </p>
                    </>
                  )}
                  <label className="field">
                    <span>Days to show</span>
                    <input
                      type="number"
                      min={1}
                      max={120}
                      value={settings.dayCount}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          dayCount: Number(e.target.value) || 30,
                        })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>Library</span>
                    <select
                      value={settings.librarySectionId}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          librarySectionId: e.target.value,
                        })
                      }
                    >
                      <option value="">Select library…</option>
                      {libraries.map((lib) => (
                        <option key={lib.id} value={lib.id}>
                          {lib.title} ({lib.type})
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Plex client (TV / stick)</span>
                    <select
                      value={settings.clientMachineId}
                      onChange={(e) => {
                        const client = clients.find(
                          (c) => c.machineIdentifier === e.target.value,
                        );
                        setSettings({
                          ...settings,
                          clientMachineId: e.target.value,
                          clientName: client?.name || "",
                        });
                      }}
                    >
                      <option value="">Select client…</option>
                      {clients.map((client) => (
                        <option
                          key={client.machineIdentifier}
                          value={client.machineIdentifier}
                        >
                          {client.name}
                          {client.product ? ` · ${client.product}` : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="settings-hint">
                    Open the Plex app on your TV/stick first, then hit Refresh if
                    the list is empty.
                  </p>
                  <div className="workouts-toolbar">
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() => void save()}
                    >
                      {busy ? "Saving…" : "Save setup"}
                    </button>
                  </div>
                </section>
              )}

              <section className="settings-group">
                <h3>Today’s workout</h3>
                {!configured && (
                  <p className="settings-hint">
                    Finish Setup (token, library, client), then pick a day.
                  </p>
                )}
                {configured && days.length === 0 && !error && (
                  <div className="sync-alert sync-alert-err">
                    No day videos found. Usually this means Plex isn’t reachable
                    from this PC (common at work if the hub isn’t on your Plex
                    machine), the wrong library is selected, or files aren’t
                    named with your day pattern yet. Open Plex on the TV, hit
                    Refresh, and use this on the home Plex PC.
                  </div>
                )}
                {configured && days.length > 0 && clients.length === 0 && (
                  <div className="sync-alert sync-alert-err">
                    No Plex clients online. Open the Plex app on your TV/stick
                    (on the home network), then Refresh. Playback is meant to
                    run from the hub on your Plex PC at home.
                  </div>
                )}
                {warmup ? (
                  <p className="settings-hint">
                    Warm-up found: <strong>{warmup.title}</strong>
                    {settings.clientName ? (
                      <>
                        {" "}
                        · Client: <strong>{settings.clientName}</strong>
                      </>
                    ) : null}
                    {days.length > 0 ? (
                      <>
                        {" "}
                        · {days.length} day
                        {days.length === 1 ? "" : "s"} ready
                      </>
                    ) : null}
                  </p>
                ) : configured ? (
                  <p className="settings-hint">
                    No warm-up match for “{settings.warmupTitle}” yet — check
                    the title in Setup.
                  </p>
                ) : null}

                <div className="workout-day-grid">
                  {dayButtons.map(({ day, found }) => (
                    <button
                      key={day}
                      type="button"
                      className={`workout-day-btn${found ? " found" : ""}${
                        playingDay === day ? " playing" : ""
                      }`}
                      disabled={!configured || !found || playingDay !== null}
                      title={
                        found
                          ? found.title
                          : "Video not found in the selected Plex library"
                      }
                      onClick={() => void playDay(day)}
                    >
                      <span className="workout-day-num">{day}</span>
                      <span className="workout-day-label">
                        {playingDay === day
                          ? "Starting…"
                          : found
                            ? "Play"
                            : "Missing"}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            </>
          )}

          {message && (
            <div className="sync-alert sync-alert-ok">{message}</div>
          )}
          {error && <div className="sync-alert sync-alert-err">{error}</div>}
        </div>
      </div>
    </div>
  );
}
