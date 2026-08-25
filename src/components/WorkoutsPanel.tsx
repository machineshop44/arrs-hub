import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type WorkoutSettings = {
  plexBaseUrl: string;
  plexToken: string;
  plexTokenSet?: boolean;
  plexUsername?: string;
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
  castType?: string;
  deviceClass?: string;
  platform?: string;
  kind?: "local" | "tv" | "speaker" | "phone" | "app";
  kindLabel?: string;
};
type DayItem = { day: number; title: string; ratingKey: string };
type PlaylistItem = {
  title: string;
  ratingKey: string;
  url: string;
  seekable?: boolean;
  durationMs?: number | null;
};

const LOCAL_CLIENT_ID = "arrs-hub-local";

function formatClock(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Absolute hub media URL with mode=direct&player=vlc (same as Arrs Hub Mobile). */
function toVlcDirectMediaUrl(url: string): string {
  const trimmed = String(url || "").trim();
  if (!trimmed) return trimmed;
  try {
    const next = new URL(trimmed, window.location.origin);
    if (!next.pathname.includes("/api/workouts/media/")) {
      return next.toString();
    }
    next.searchParams.set("mode", "direct");
    next.searchParams.set("player", "vlc");
    return next.toString();
  } catch {
    return trimmed;
  }
}

async function openLocalPlaylistInVlc(
  playlist: PlaylistItem[],
): Promise<{ ok: boolean; error?: string }> {
  const urls = playlist.map((item) => toVlcDirectMediaUrl(item.url)).filter(Boolean);
  if (urls.length === 0) {
    return { ok: false, error: "No playlist URLs for VLC." };
  }
  const desktop = window.arrsHubDesktop;
  if (desktop?.playInVlc) {
    return desktop.playInVlc(urls);
  }
  // Browser-only (not Electron): open first clip; user can install desktop app for playlist.
  window.open(urls[0], "_blank", "noopener,noreferrer");
  return {
    ok: true,
    error:
      urls.length > 1
        ? "Opened first clip in a new tab (install Arrs Hub desktop + VLC for full warm-up→day playlist)."
        : undefined,
  };
}

function withStreamOffset(url: string, offsetSeconds: number) {
  try {
    const next = new URL(url);
    // Plex universal transcoder uses milliseconds
    next.searchParams.set("offset", String(Math.max(0, Math.floor(offsetSeconds * 1000))));
    next.searchParams.set("X-Plex-Session-Id", `${Date.now()}`);
    return next.toString();
  } catch {
    return url;
  }
}

function WorkoutPlayer({
  playlist,
  index,
  onIndexChange,
  onClose,
  onFinished,
}: {
  playlist: PlaylistItem[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  onFinished: () => void;
}) {
  const item = playlist[index];
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [src, setSrc] = useState(item.url);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(
    item.durationMs ? item.durationMs / 1000 : 0,
  );
  const [scrubbing, setScrubbing] = useState(false);
  const [readyPrompt, setReadyPrompt] = useState(false);
  const [playError, setPlayError] = useState<string | null>(null);
  const nextItem = playlist[index + 1];
  const isWarmup = index === 0 && playlist.length > 1;

  useEffect(() => {
    setSrc(item.url);
    setCurrent(0);
    setDuration(item.durationMs ? item.durationMs / 1000 : 0);
    setReadyPrompt(false);
    setPlayError(null);
  }, [item.url, item.durationMs, index]);

  const seekTo = (seconds: number) => {
    const video = videoRef.current;
    const target = Math.max(0, seconds);
    if (item.seekable !== false && video && Number.isFinite(video.duration) && video.duration > 0) {
      video.currentTime = Math.min(target, video.duration);
      setCurrent(video.currentTime);
      return;
    }
    // Transcode streams: restart from offset so scrubbing still works
    setSrc(withStreamOffset(item.url, target));
    setCurrent(target);
  };

  const continueToDay = () => {
    setReadyPrompt(false);
    onIndexChange(index + 1);
  };

  if (!item) return null;

  return (
    <div className="workout-player-overlay" role="presentation">
      <div className="workout-player">
        <header className="workout-player-header">
          <div>
            <strong>
              {index === 0 ? "Warm-up" : "Workout"} · {item.title}
            </strong>
            <p className="settings-hint">
              {index + 1} of {playlist.length}
              {isWarmup
                ? " — warm-up first; you’ll confirm before the day video"
                : ""}
            </p>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Close player"
          >
            ✕
          </button>
        </header>
        <video
          ref={videoRef}
          key={src}
          className="workout-player-video"
          src={src}
          controls
          autoPlay
          playsInline
          preload="auto"
          onError={() => {
            setPlayError(
              "Could not play this stream (often AC3 audio / empty transcoder). " +
                "Update Arrs Hub if you are behind, or install ffmpeg on this PC.",
            );
          }}
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (Number.isFinite(d) && d > 0) setDuration(d);
          }}
          onTimeUpdate={(e) => {
            if (!scrubbing) setCurrent(e.currentTarget.currentTime || 0);
          }}
          onEnded={() => {
            if (isWarmup) {
              setReadyPrompt(true);
              return;
            }
            if (index < playlist.length - 1) onIndexChange(index + 1);
            else onFinished();
          }}
        />
        {playError ? (
          <p className="settings-error" role="alert">
            {playError}
          </p>
        ) : null}
        <div className="workout-player-controls">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => seekTo(current - 10)}
          >
            −10s
          </button>
          <input
            className="workout-scrub"
            type="range"
            min={0}
            max={Math.max(
              duration || (item.durationMs ? item.durationMs / 1000 : 0) || 1,
              1,
            )}
            step={1}
            value={Math.min(current, duration || current)}
            onMouseDown={() => setScrubbing(true)}
            onTouchStart={() => setScrubbing(true)}
            onChange={(e) => setCurrent(Number(e.target.value))}
            onMouseUp={(e) => {
              setScrubbing(false);
              seekTo(Number((e.target as HTMLInputElement).value));
            }}
            onTouchEnd={(e) => {
              setScrubbing(false);
              seekTo(Number((e.target as HTMLInputElement).value));
            }}
            aria-label="Scrub video"
          />
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => seekTo(current + 10)}
          >
            +10s
          </button>
          <span className="workout-player-time">
            {formatClock(current)} / {formatClock(duration || (item.durationMs || 0) / 1000)}
          </span>
        </div>

        {readyPrompt && nextItem && (
          <div
            className="workout-ready-overlay"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="workout-ready-title"
            aria-describedby="workout-ready-desc"
          >
            <div className="workout-ready-card">
              <h3 id="workout-ready-title">Are you ready to move on?</h3>
              <p id="workout-ready-desc" className="settings-hint">
                Continue to today’s workout video
                {nextItem.title ? ` (“${nextItem.title}”)` : ""}? It starts with
                a warm-up stretch.
              </p>
              <div className="workout-ready-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setReadyPrompt(false)}
                >
                  Not yet
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={continueToDay}
                  autoFocus
                >
                  Continue
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

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
  const [playlist, setPlaylist] = useState<PlaylistItem[] | null>(null);
  const [playlistIndex, setPlaylistIndex] = useState(0);
  const [castReadyDay, setCastReadyDay] = useState<{
    day: number;
    dayTitle: string;
    client: string;
  } | null>(null);
  const [authPolling, setAuthPolling] = useState(false);
  const [showManualToken, setShowManualToken] = useState(false);
  const authPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const configured = Boolean(
    settings?.plexTokenSet && settings.librarySectionId,
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
      plexUsername: loaded.plexUsername || "",
      librarySectionId: loaded.librarySectionId || "",
      matchMode: loaded.matchMode === "title" ? "title" : "episode",
      showTitle: loaded.showTitle || "Fit With the Force",
      seasonNumber: loaded.seasonNumber ?? 1,
      warmupEpisode: loaded.warmupEpisode ?? 2,
      firstDayEpisode: loaded.firstDayEpisode ?? 3,
      warmupTitle: loaded.warmupTitle || "Warm Up",
      dayTitlePattern: loaded.dayTitlePattern || "Day {n}",
      clientMachineId: loaded.clientMachineId || LOCAL_CLIENT_ID,
      clientName: loaded.clientName || "This device (play here)",
      dayCount: loaded.dayCount || 30,
    };
    if (!next.plexBaseUrl && suggestedPlexUrl) {
      next.plexBaseUrl = suggestedPlexUrl;
    }
    setSettings(next);
    setShowSetup(!(next.plexTokenSet && next.librarySectionId));
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

  useEffect(() => {
    return () => {
      if (authPollRef.current) clearInterval(authPollRef.current);
    };
  }, []);

  const stopAuthPoll = () => {
    if (authPollRef.current) {
      clearInterval(authPollRef.current);
      authPollRef.current = null;
    }
    setAuthPolling(false);
  };

  const signInWithPlex = async () => {
    setBusy(true);
    setMessage(null);
    setError(null);
    stopAuthPoll();
    try {
      const res = await fetch("/api/workouts/plex/auth/start", {
        method: "POST",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not start Plex login");

      const authUrl = String(json.authUrl || "");
      const pinId = String(json.pinId || "");
      if (!authUrl || !pinId) {
        throw new Error("Plex login did not return an auth URL.");
      }

      window.open(authUrl, "arrs-hub-plex-auth", "noopener,noreferrer");
      setAuthPolling(true);
      setMessage("Waiting for Plex sign-in… finish in the browser tab that opened.");

      authPollRef.current = setInterval(() => {
        void (async () => {
          try {
            const pollRes = await fetch(
              `/api/workouts/plex/auth/poll?pinId=${encodeURIComponent(pinId)}`,
            );
            const pollJson = await pollRes.json();
            if (!pollRes.ok) {
              stopAuthPoll();
              setError(pollJson.error || "Plex login failed");
              setMessage(null);
              return;
            }
            if (pollJson.authenticated && pollJson.settings) {
              stopAuthPoll();
              setSettings(pollJson.settings as WorkoutSettings);
              setMessage(
                pollJson.username
                  ? `Signed in as ${pollJson.username}.`
                  : "Signed in with Plex.",
              );
              setError(null);
              await refreshMeta();
            }
          } catch (err) {
            stopAuthPoll();
            setError(err instanceof Error ? err.message : String(err));
            setMessage(null);
          }
        })();
      }, 1500);
    } catch (err) {
      stopAuthPoll();
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const signOutPlex = async () => {
    setBusy(true);
    setMessage(null);
    setError(null);
    stopAuthPoll();
    try {
      const res = await fetch("/api/workouts/plex/auth/logout", {
        method: "POST",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Sign out failed");
      if (json.settings) setSettings(json.settings as WorkoutSettings);
      else {
        setSettings((prev) =>
          prev
            ? {
                ...prev,
                plexToken: "",
                plexTokenSet: false,
                plexUsername: "",
              }
            : prev,
        );
      }
      setLibraries([]);
      setClients([]);
      setDays([]);
      setWarmup(null);
      setMessage("Signed out of Plex.");
      setShowSetup(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

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

  const playDay = async (day: number, opts?: { skipWarmup?: boolean }) => {
    if (!settings?.clientMachineId) {
      setError("Pick a device under Play on first.");
      return;
    }
    setPlayingDay(day);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch("/api/workouts/play", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          day,
          clientMachineId: settings.clientMachineId,
          skipWarmup: Boolean(opts?.skipWarmup),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Play failed");
      if (json.mode === "local" && Array.isArray(json.playlist)) {
        setCastReadyDay(null);
        const items = json.playlist as PlaylistItem[];
        const vlc = await openLocalPlaylistInVlc(items);
        if (vlc.ok) {
          setPlaylist(null);
          setPlaylistIndex(0);
          setMessage(
            vlc.error
              ? vlc.error
              : `Opened in VLC (direct play, no transcode): ${json.warmup} → ${json.day}`,
          );
        } else {
          // Last resort: in-app HTML5 (needs AAC remux for AC3).
          setPlaylist(items);
          setPlaylistIndex(0);
          setMessage(
            `VLC unavailable (${vlc.error || "unknown"}). Using built-in player — install VLC for reliable AC3/Matroska play.`,
          );
          setError(vlc.error || "VLC not available");
        }
      } else if (json.awaitingDayConfirm) {
        setCastReadyDay({
          day,
          dayTitle: String(json.day || `Day ${day}`),
          client: String(json.client || "Cast"),
        });
        setMessage(
          `Warm-up finished on ${json.client}. Confirm when you’re ready for the day video.`,
        );
      } else {
        setCastReadyDay(null);
        setMessage(`Playing on ${json.client}: ${json.warmup} → ${json.day}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlayingDay(null);
    }
  };

  const closePlayer = () => {
    setPlaylist(null);
    setPlaylistIndex(0);
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
              Pick a day — warm-up plays first, then you’ll confirm before the
              day video starts (on this device or Cast).
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
                    Sign in with your Plex account — Arrs Hub keeps the token on
                    this PC (never pasted into chat). Use the server URL without{" "}
                    <code>/web</code> (example:{" "}
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
                  <div className="field">
                    <span>Plex account</span>
                    <div className="workouts-plex-auth">
                      {settings.plexTokenSet ? (
                        <>
                          <p className="settings-hint workouts-plex-signed-in">
                            Signed in
                            {settings.plexUsername
                              ? ` as ${settings.plexUsername}`
                              : ""}
                            {settings.plexToken
                              ? ` · token ${settings.plexToken}`
                              : ""}
                          </p>
                          <div className="workouts-plex-auth-actions">
                            <button
                              type="button"
                              className="btn btn-secondary"
                              disabled={busy || authPolling}
                              onClick={() => void signInWithPlex()}
                            >
                              Re-sign in
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost"
                              disabled={busy || authPolling}
                              onClick={() => void signOutPlex()}
                            >
                              Sign out
                            </button>
                          </div>
                        </>
                      ) : (
                        <div className="workouts-plex-auth-actions">
                          <button
                            type="button"
                            className="btn btn-primary"
                            disabled={busy || authPolling}
                            onClick={() => void signInWithPlex()}
                          >
                            {authPolling
                              ? "Waiting for Plex…"
                              : "Sign in with Plex"}
                          </button>
                          {authPolling && (
                            <button
                              type="button"
                              className="btn btn-ghost"
                              onClick={() => {
                                stopAuthPoll();
                                setMessage(null);
                              }}
                            >
                              Cancel
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  <details
                    className="workouts-advanced-token"
                    open={showManualToken}
                    onToggle={(e) =>
                      setShowManualToken(
                        (e.target as HTMLDetailsElement).open,
                      )
                    }
                  >
                    <summary>Advanced: paste token manually</summary>
                    <p className="settings-hint">
                      Only needed if browser login fails.{" "}
                      <a
                        href="https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Find your X-Plex-Token
                      </a>
                      .
                    </p>
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
                  </details>
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
                        Looks inside the TV show for episode titles like{" "}
                        <strong>Day 1</strong>, <strong>Day 2</strong>, and a
                        warm-up title containing <strong>Warm Up</strong> (e.g.
                        &quot;Full Body Warm Up In 5 Minutes&quot;). Episode #
                        fields are only a fallback if a title has no Day N.
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
                {configured && (
                  <label className="field">
                    <span>Play on</span>
                    <select
                      value={settings.clientMachineId || LOCAL_CLIENT_ID}
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
                      {clients.map((client) => (
                        <option
                          key={client.machineIdentifier}
                          value={client.machineIdentifier}
                        >
                          {client.kind === "tv"
                            ? "TV · "
                            : client.kind === "speaker"
                              ? "Speaker · "
                              : client.kind === "phone"
                                ? "Phone · "
                                : client.kind === "app"
                                  ? "App · "
                                  : client.castType === "chromecast"
                                    ? "Cast · "
                                    : client.castType === "plex"
                                      ? "Plex · "
                                      : ""}
                          {client.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <p className="settings-hint">
                  Pick where to play each time. <strong>This device</strong>{" "}
                  opens <strong>VLC</strong> with a direct hub stream (no
                  browser transcode — same as Arrs Hub Mobile). Install{" "}
                  <a
                    href="https://www.videolan.org/vlc/"
                    target="_blank"
                    rel="noreferrer"
                  >
                    VLC for Windows
                  </a>{" "}
                  if needed. <strong>Cast</strong> / controllable{" "}
                  <strong>Plex</strong> apps appear when they&apos;re on the
                  network — hit Refresh.
                </p>
                {!configured && (
                  <p className="settings-hint">
                    Finish Setup (token + library), then pick a day.
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
                    No playback targets found. Hit Refresh — you should at least
                    see &quot;This device (play here)&quot;.
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

        {playlist && (
          <WorkoutPlayer
            playlist={playlist}
            index={playlistIndex}
            onIndexChange={setPlaylistIndex}
            onClose={closePlayer}
            onFinished={() => {
              closePlayer();
              setMessage("Workout finished.");
            }}
          />
        )}

        {castReadyDay && !playlist && (
          <div
            className="workout-ready-overlay workout-ready-overlay-panel"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="cast-ready-title"
            aria-describedby="cast-ready-desc"
          >
            <div className="workout-ready-card">
              <h3 id="cast-ready-title">Are you ready to move on?</h3>
              <p id="cast-ready-desc" className="settings-hint">
                Warm-up finished on {castReadyDay.client}. Continue to today’s
                workout
                {castReadyDay.dayTitle
                  ? ` (“${castReadyDay.dayTitle}”)`
                  : ""}
                ?
              </p>
              <div className="workout-ready-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setCastReadyDay(null)}
                >
                  Not yet
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={playingDay != null}
                  onClick={() => {
                    const pending = castReadyDay;
                    setCastReadyDay(null);
                    void playDay(pending.day, { skipWarmup: true });
                  }}
                >
                  Continue
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
