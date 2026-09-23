import { useEffect, useMemo, useState } from "react";
import { useModalBackdropClose } from "../hooks/useModalBackdropClose";
import type { ConnectionMode, ServiceConfig } from "../types";
import { getServiceUrl } from "../types";
import { SERVICE_ICONS } from "../assets/icons";

export type OmbiSearchMode = "media" | "music";

export type OmbiSearchHit = {
  key: string;
  kind: "movie" | "tv" | "music";
  title: string;
  year: string;
  overview: string;
  posterUrl: string | null;
  tmdbId: number | null;
  tvdbId: number | null;
  foreignArtistId: string | null;
  foreignAlbumId: string | null;
  available: boolean;
  requested: boolean;
  approved: boolean;
};

interface OmbiPanelProps {
  onClose: () => void;
  services: ServiceConfig[];
  connectionMode: ConnectionMode;
  onOpenSettings?: () => void;
}

const MODE_OPTIONS: { id: OmbiSearchMode; label: string }[] = [
  { id: "media", label: "Movies & TV" },
  { id: "music", label: "Music" },
];

function urlMap(
  services: ServiceConfig[],
  connectionMode: ConnectionMode,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const service of services) {
    const url = getServiceUrl(service, connectionMode);
    if (url) map[service.id] = url;
  }
  return map;
}

function ombiHitStatusLabel(hit: OmbiSearchHit): string {
  if (hit.available) return "Available";
  if (hit.approved) return "Approved";
  if (hit.requested) return "Requested";
  return "Not requested";
}

function ombiKindLabel(kind: OmbiSearchHit["kind"]): string {
  if (kind === "movie") return "Movie";
  if (kind === "tv") return "TV";
  return "Music";
}

export function OmbiPanel({
  onClose,
  services,
  connectionMode,
  onOpenSettings,
}: OmbiPanelProps) {
  const backdrop = useModalBackdropClose(onClose);
  const [mode, setMode] = useState<OmbiSearchMode>("media");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<OmbiSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);

  const ombiService = useMemo(
    () => services.find((s) => s.id === "ombi"),
    [services],
  );
  const ombiWebUrl = ombiService
    ? getServiceUrl(ombiService, connectionMode)
    : null;
  const urls = useMemo(
    () => urlMap(services, connectionMode),
    [services, connectionMode],
  );

  useEffect(() => {
    setResults([]);
    setError(null);
    setMessage(null);
  }, [mode]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/integrations/settings");
        const json = (await res.json()) as {
          settings?: { ombi?: { apiKeySet?: boolean; baseUrl?: string } };
        };
        if (cancelled) return;
        const ombi = json.settings?.ombi;
        setConfigured(
          Boolean(ombi?.apiKeySet && (ombi.baseUrl || ombiWebUrl)),
        );
      } catch {
        if (!cancelled) setConfigured(Boolean(ombiWebUrl));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ombiWebUrl]);

  const runSearch = async () => {
    setSearching(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/activity/ombi/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, query, urls }),
      });
      const json = (await res.json()) as {
        error?: string;
        results?: OmbiSearchHit[];
        configured?: boolean;
      };
      if (!res.ok) throw new Error(json.error || "Ombi search failed");
      if (json.configured === false) setConfigured(false);
      else setConfigured(true);
      const hits = Array.isArray(json.results) ? json.results : [];
      setResults(hits);
      if (!hits.length) {
        setMessage(
          mode === "music"
            ? "No albums/artists — check Lidarr is enabled in Ombi, or try an album title."
            : "No results — try a different title.",
        );
      }
    } catch (err) {
      setResults([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  };

  const onRequest = async (hit: OmbiSearchHit) => {
    if (busyKey) return;
    setBusyKey(hit.key);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/activity/ombi/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: hit.kind,
          title: hit.title,
          tmdbId: hit.tmdbId,
          tvdbId: hit.tvdbId,
          foreignAlbumId: hit.foreignAlbumId,
          available: hit.available,
          requested: hit.requested,
          approved: hit.approved,
          urls,
        }),
      });
      const json = (await res.json()) as { error?: string; message?: string };
      if (!res.ok) throw new Error(json.error || "Request failed");
      setMessage(json.message || `Requested “${hit.title}”.`);
      setResults((prev) =>
        prev.map((row) =>
          row.key === hit.key ? { ...row, requested: true } : row,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  };

  const openOmbiWeb = () => {
    if (!ombiWebUrl) {
      setError("Ombi URL is not set on the dashboard service card.");
      return;
    }
    window.open(ombiWebUrl, "_blank", "noopener,noreferrer");
  };

  return (
    <div
      className="settings-overlay"
      role="presentation"
      onPointerDown={backdrop.onPointerDown}
      onPointerUp={backdrop.onPointerUp}
    >
      <div
        className="settings-panel ombi-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="ombi-panel-title"
        aria-modal="true"
      >
        <header className="settings-header">
          <div className="ombi-panel-title-row">
            <img
              src={SERVICE_ICONS.ombi}
              alt=""
              width={28}
              height={28}
              draggable={false}
            />
            <div>
              <h2 id="ombi-panel-title">Ombi Search &amp; Request</h2>
              <p className="streams-summary">
                Movies &amp; TV share one search. Music searches Lidarr albums.
                Pending approvals stay on the dashboard Ombi chip.
              </p>
            </div>
          </div>
          <div className="streams-header-actions">
            {onOpenSettings ? (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={onOpenSettings}
              >
                Settings
              </button>
            ) : null}
            <button
              type="button"
              className="icon-btn"
              onClick={onClose}
              aria-label="Close Ombi"
            >
              ✕
            </button>
          </div>
        </header>

        <div className="settings-body">
          {configured === false && (
            <div className="sync-alert sync-alert-err">
              Ombi Home URL + API key required (Port Watch / Apps monitoring —
              same key as Ombi → Settings → Configuration → General).
              {onOpenSettings ? (
                <>
                  {" "}
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={onOpenSettings}
                  >
                    Open settings
                  </button>
                </>
              ) : null}
            </div>
          )}

          {error && <div className="sync-alert sync-alert-err">{error}</div>}
          {message && !error && (
            <div className="sync-alert sync-alert-ok">{message}</div>
          )}

          <div className="ombi-toolbar">
            {MODE_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={
                  mode === opt.id ? "btn btn-primary" : "btn btn-secondary"
                }
                disabled={searching}
                onClick={() => setMode(opt.id)}
              >
                {opt.label}
              </button>
            ))}
            <button
              type="button"
              className="btn btn-ghost"
              onClick={openOmbiWeb}
              disabled={!ombiWebUrl}
            >
              Open Ombi web
            </button>
          </div>

          <form
            className="ombi-search-row"
            onSubmit={(e) => {
              e.preventDefault();
              void runSearch();
            }}
          >
            <input
              type="search"
              placeholder={
                mode === "music"
                  ? "Search albums or artists…"
                  : "Search movies & TV…"
              }
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              disabled={searching || configured === false}
            />
            <button
              type="submit"
              className="btn btn-primary"
              disabled={
                searching ||
                configured === false ||
                query.trim().length < 2
              }
            >
              {searching ? "Searching…" : "Search"}
            </button>
          </form>

          <ul className="ombi-search-list">
            {results.map((hit) => {
              const status = ombiHitStatusLabel(hit);
              const canRequest =
                !hit.available &&
                !hit.requested &&
                !hit.approved &&
                (hit.kind !== "music" || Boolean(hit.foreignAlbumId));
              return (
                <li key={hit.key} className="ombi-search-item">
                  {hit.posterUrl ? (
                    <img
                      className="ombi-search-poster"
                      src={hit.posterUrl}
                      alt=""
                      loading="lazy"
                    />
                  ) : (
                    <span
                      className="ombi-search-poster placeholder"
                      aria-hidden
                    >
                      {hit.kind === "movie"
                        ? "🎬"
                        : hit.kind === "tv"
                          ? "📺"
                          : "🎵"}
                    </span>
                  )}
                  <div className="ombi-search-body">
                    <strong>
                      <span className="ombi-kind-badge">
                        {ombiKindLabel(hit.kind)}
                      </span>{" "}
                      {hit.title}
                      {hit.year ? ` (${hit.year})` : ""}
                    </strong>
                    <span className="ombi-search-meta">{status}</span>
                    {hit.overview ? (
                      <p className="ombi-search-overview">{hit.overview}</p>
                    ) : null}
                    <div className="ombi-search-actions">
                      {canRequest ? (
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={busyKey != null}
                          onClick={() => void onRequest(hit)}
                        >
                          {busyKey === hit.key ? "Requesting…" : "Request"}
                        </button>
                      ) : hit.kind === "music" && !hit.foreignAlbumId ? (
                        <span className="ombi-search-hint">
                          Artist only — search an album title, or use Ombi web
                        </span>
                      ) : (
                        <span className="ombi-search-hint">{status}</span>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}
