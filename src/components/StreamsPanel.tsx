import { useCallback, useEffect, useMemo, useState } from "react";

type TautulliSettings = {
  baseUrl: string;
  apiKey: string;
  apiKeySet?: boolean;
};

type StreamSession = {
  sessionKey: string;
  state: string;
  mediaType: string;
  title: string;
  fullTitle: string;
  grandparentTitle: string;
  parentTitle: string;
  year: string;
  user: string;
  username: string;
  player: string;
  product: string;
  platform: string;
  device: string;
  location: string;
  qualityProfile: string;
  videoResolution: string;
  streamContainer: string;
  videoDecision: string;
  audioDecision: string;
  transcodeDecision: string;
  progressPercent: number;
  viewOffset: number;
  duration: number;
  bandwidth: number;
  streamBitrate: number;
  thumb: string;
  ratingKey: string;
  libraryName: string;
};

type ActivityPayload = {
  streamCount: number;
  streamCountDirectPlay: number;
  streamCountDirectStream: number;
  streamCountTranscode: number;
  totalBandwidth: number;
  lanBandwidth: number;
  wanBandwidth: number;
  sessions: StreamSession[];
};

interface StreamsPanelProps {
  onClose: () => void;
  /** Suggested Tautulli base URL from hub service Home URL */
  suggestedBaseUrl?: string;
}

const REFRESH_MS = 7000;

function normalizeBaseUrl(url?: string) {
  let value = String(url || "").trim();
  if (!value) return "";
  value = value.replace(/\/home\/?$/i, "");
  value = value.replace(/\/$/, "");
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  return value;
}

function formatMs(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return "0:00";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatBandwidth(kbps: number) {
  if (!Number.isFinite(kbps) || kbps <= 0) return null;
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
  return `${Math.round(kbps)} kbps`;
}

function decisionClass(decision: string) {
  const d = decision.toLowerCase();
  if (d.includes("transcode")) return "stream-decision-transcode";
  if (d.includes("direct stream")) return "stream-decision-direct-stream";
  if (d.includes("direct play")) return "stream-decision-direct-play";
  return "";
}

function episodeLine(session: StreamSession) {
  if (session.mediaType !== "episode") {
    return session.year ? `(${session.year})` : session.libraryName || "";
  }
  const show = session.grandparentTitle;
  const season = session.parentTitle;
  const ep = session.title;
  if (show && season && ep) return `${show} — ${season} · ${ep}`;
  if (show && ep) return `${show} — ${ep}`;
  return session.fullTitle;
}

function imageSrc(session: StreamSession) {
  const params = new URLSearchParams();
  if (session.thumb) params.set("img", session.thumb);
  else if (session.ratingKey) params.set("rating_key", session.ratingKey);
  else return "";
  params.set("width", "200");
  params.set("height", "300");
  params.set("fallback", "poster");
  return `/api/tautulli/image?${params.toString()}`;
}

export function StreamsPanel({
  onClose,
  suggestedBaseUrl,
}: StreamsPanelProps) {
  const [settings, setSettings] = useState<TautulliSettings | null>(null);
  const [activity, setActivity] = useState<ActivityPayload | null>(null);
  const [serverUp, setServerUp] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);

  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{
    type: "ok" | "err";
    text: string;
  } | null>(null);
  const [showSetup, setShowSetup] = useState(false);

  const applySettings = useCallback((next: TautulliSettings) => {
    setSettings(next);
    const suggested = normalizeBaseUrl(suggestedBaseUrl);
    const saved = normalizeBaseUrl(next.baseUrl);
    setBaseUrl(
      next.apiKeySet
        ? saved || suggested || "http://localhost:8181"
        : suggested || saved || "http://localhost:8181",
    );
    setApiKey("");
    setNeedsSetup(!next.apiKeySet);
    if (!next.apiKeySet) setShowSetup(true);
  }, [suggestedBaseUrl]);

  const loadActivity = useCallback(async (opts?: { quiet?: boolean }) => {
    try {
      const health = await fetch("/api/health");
      setServerUp(health.ok);
      if (!health.ok) {
        setError("Hub API is offline — start Arrs Hub server.");
        setLoading(false);
        return;
      }

      const res = await fetch("/api/tautulli/activity");
      const json = await res.json();

      if (json.settings) applySettings(json.settings as TautulliSettings);

      if (!res.ok) {
        if (json.code === "TAUTULLI_NOT_CONFIGURED" || !json.settings?.apiKeySet) {
          setNeedsSetup(true);
          setShowSetup(true);
          setActivity(null);
          setError(null);
        } else {
          setError(json.error || "Could not load Tautulli activity");
        }
        setLoading(false);
        return;
      }

      setNeedsSetup(false);
      setActivity(json.activity as ActivityPayload);
      setError(null);
      setLoading(false);
    } catch (err) {
      if (!opts?.quiet) {
        setError(err instanceof Error ? err.message : String(err));
      }
      setLoading(false);
    }
  }, [applySettings]);

  useEffect(() => {
    void loadActivity();
  }, [loadActivity]);

  useEffect(() => {
    if (needsSetup || serverUp === false) return;
    const id = window.setInterval(() => {
      void loadActivity({ quiet: true });
    }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [loadActivity, needsSetup, serverUp]);

  const saveSettings = async () => {
    setBusy(true);
    setSaveMessage(null);
    try {
      const res = await fetch("/api/tautulli/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: baseUrl.trim() || suggestedBaseUrl || "http://localhost:8181",
          apiKey,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      applySettings(json.settings as TautulliSettings);
      setSaveMessage({
        type: "ok",
        text: "Tautulli settings saved on this PC.",
      });
      setShowSetup(false);
      setLoading(true);
      await loadActivity();
    } catch (err) {
      setSaveMessage({
        type: "err",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const summary = useMemo(() => {
    if (!activity) return null;
    const parts = [
      `${activity.streamCount} stream${activity.streamCount === 1 ? "" : "s"}`,
    ];
    const bw = formatBandwidth(activity.totalBandwidth);
    if (bw) parts.push(bw);
    return parts.join(" · ");
  }, [activity]);

  return (
    <div className="settings-overlay" onClick={onClose} role="presentation">
      <div
        className="settings-panel streams-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="streams-title"
        aria-modal="true"
      >
        <header className="settings-header">
          <div>
            <h2 id="streams-title">Streams</h2>
            {summary && !needsSetup && (
              <p className="streams-summary">{summary}</p>
            )}
          </div>
          <div className="streams-header-actions">
            {!needsSetup && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setShowSetup((v) => !v)}
              >
                {showSetup ? "Hide setup" : "Setup"}
              </button>
            )}
            <button
              type="button"
              className="btn btn-ghost"
              disabled={loading || busy || serverUp === false}
              onClick={() => {
                setLoading(true);
                void loadActivity();
              }}
            >
              Refresh
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={onClose}
              aria-label="Close streams"
            >
              ✕
            </button>
          </div>
        </header>

        <div className="settings-body">
          {(needsSetup || showSetup) && (
            <section className="settings-group streams-setup">
              <h3>Tautulli connection</h3>
              <p className="settings-hint">
                Paste your API key from{" "}
                <strong>Tautulli → Settings → Web Interface → API</strong>.
                Enable the API if it is off. The base URL can match your Tautulli
                Home URL in hub Settings (usually{" "}
                <code>http://localhost:8181</code>). Keys stay on this PC under
                the hub data folder — never committed to Git.
              </p>
              {serverUp === false && (
                <p className="settings-hint">
                  Hub API is offline — start the hub server to save settings.
                </p>
              )}
              <label className="field">
                <span>Tautulli base URL</span>
                <input
                  type="text"
                  className="url-input"
                  value={baseUrl}
                  placeholder={suggestedBaseUrl || "http://localhost:8181"}
                  disabled={serverUp === false || busy}
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
              </label>
              <label className="field">
                <span>
                  API key
                  {settings?.apiKeySet ? " (saved — leave blank to keep)" : ""}
                </span>
                <input
                  type="password"
                  autoComplete="off"
                  placeholder={
                    settings?.apiKeySet ? "•••• saved ••••" : "Paste API key"
                  }
                  value={apiKey}
                  disabled={serverUp === false || busy}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </label>
              {saveMessage && (
                <div
                  className={`sync-alert ${saveMessage.type === "ok" ? "sync-alert-ok" : "sync-alert-err"}`}
                >
                  {saveMessage.text}
                </div>
              )}
              <button
                type="button"
                className="btn btn-secondary"
                disabled={serverUp === false || busy}
                onClick={() => void saveSettings()}
              >
                {busy ? "Saving…" : "Save & load streams"}
              </button>
            </section>
          )}

          {error && !needsSetup && (
            <div className="sync-alert sync-alert-err">{error}</div>
          )}

          {!needsSetup && !error && loading && !activity && (
            <div className="streams-empty">
              <p>Loading activity…</p>
            </div>
          )}

          {!needsSetup && !error && activity && activity.sessions.length === 0 && (
            <div className="streams-empty">
              <div className="streams-empty-icon" aria-hidden>
                📺
              </div>
              <p>Nobody is watching</p>
              <small>Activity refreshes automatically every few seconds.</small>
            </div>
          )}

          {!needsSetup && activity && activity.sessions.length > 0 && (
            <div className="streams-list">
              {activity.sessions.map((session) => {
                const src = imageSrc(session);
                const bw = formatBandwidth(
                  session.bandwidth || session.streamBitrate,
                );
                const quality =
                  session.videoResolution ||
                  session.qualityProfile ||
                  session.streamContainer;
                const playerLine = [session.product || session.player, session.platform]
                  .filter(Boolean)
                  .join(" · ");

                return (
                  <article
                    key={session.sessionKey || `${session.user}-${session.fullTitle}`}
                    className="stream-card"
                  >
                    <div className="stream-poster">
                      {src ? (
                        <img
                          src={src}
                          alt=""
                          loading="lazy"
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display = "none";
                          }}
                        />
                      ) : (
                        <div className="stream-poster-fallback">🎬</div>
                      )}
                      <span
                        className={`stream-state stream-state-${session.state === "paused" ? "paused" : "playing"}`}
                      >
                        {session.state === "paused" ? "Paused" : "Playing"}
                      </span>
                    </div>

                    <div className="stream-body">
                      <div className="stream-title-row">
                        <h3 className="stream-title">
                          {session.mediaType === "episode" && session.grandparentTitle
                            ? session.grandparentTitle
                            : session.fullTitle}
                        </h3>
                        <span
                          className={`stream-decision ${decisionClass(session.transcodeDecision)}`}
                        >
                          {session.transcodeDecision}
                        </span>
                      </div>
                      <p className="stream-subtitle">{episodeLine(session)}</p>

                      <div className="stream-meta">
                        <span>{session.user}</span>
                        {playerLine && <span>{playerLine}</span>}
                        {session.location && (
                          <span className="stream-location">
                            {session.location.toUpperCase()}
                          </span>
                        )}
                      </div>

                      <div className="stream-progress">
                        <div className="stream-progress-bar">
                          <div
                            className="stream-progress-fill"
                            style={{
                              width: `${Math.max(0, Math.min(100, session.progressPercent))}%`,
                            }}
                          />
                        </div>
                        <div className="stream-progress-labels">
                          <span>
                            {formatMs(session.viewOffset)} /{" "}
                            {formatMs(session.duration)}
                          </span>
                          <span>{Math.round(session.progressPercent)}%</span>
                        </div>
                      </div>

                      <div className="stream-details">
                        {quality && <span>{quality}</span>}
                        {session.streamContainer && quality !== session.streamContainer && (
                          <span>{session.streamContainer.toUpperCase()}</span>
                        )}
                        {bw && <span>{bw}</span>}
                        {session.videoDecision &&
                          session.videoDecision !== session.transcodeDecision && (
                            <span>Video: {session.videoDecision}</span>
                          )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
