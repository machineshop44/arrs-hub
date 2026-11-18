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

type OmbiRootFolder = {
  id: number;
  path: string;
  freeSpace: number | null;
};

type SeasonMode = "first" | "all";

type RequestDraft = {
  hit: OmbiSearchHit;
  seasonMode: SeasonMode;
  rootFolderId: number | null;
  folders: OmbiRootFolder[];
  foldersLoading: boolean;
  foldersError: string | null;
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

function formatFreeSpace(bytes: number | null): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "";
  const gib = bytes / (1024 ** 3);
  if (gib >= 100) return `${Math.round(gib)} GB free`;
  if (gib >= 1) return `${gib.toFixed(1)} GB free`;
  const mib = bytes / (1024 ** 2);
  return `${Math.round(mib)} MB free`;
}

function folderLabel(folder: OmbiRootFolder): string {
  const free = formatFreeSpace(folder.freeSpace);
  return free ? `${folder.path} (${free})` : folder.path;
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
  const [draft, setDraft] = useState<RequestDraft | null>(null);

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
    setDraft(null);
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
    setDraft(null);
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

  const loadRootFolders = async (hit: OmbiSearchHit) => {
    try {
      const res = await fetch("/api/activity/ombi/root-folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls }),
      });
      const json = (await res.json()) as {
        error?: string;
        movie?: OmbiRootFolder[];
        tv?: OmbiRootFolder[];
      };
      if (!res.ok) throw new Error(json.error || "Could not load root folders");
      const folders =
        hit.kind === "tv"
          ? Array.isArray(json.tv)
            ? json.tv
            : []
          : Array.isArray(json.movie)
            ? json.movie
            : [];
      setDraft((prev) => {
        if (!prev || prev.hit.key !== hit.key) return prev;
        return {
          ...prev,
          folders,
          rootFolderId: folders[0]?.id ?? null,
          foldersLoading: false,
          foldersError: folders.length
            ? null
            : "No root folders from Ombi — request will use Ombi’s default.",
        };
      });
    } catch (err) {
      setDraft((prev) => {
        if (!prev || prev.hit.key !== hit.key) return prev;
        return {
          ...prev,
          folders: [],
          rootFolderId: null,
          foldersLoading: false,
          foldersError:
            err instanceof Error ? err.message : String(err),
        };
      });
    }
  };

  const openRequestOptions = (hit: OmbiSearchHit) => {
    if (busyKey) return;
    setError(null);
    setMessage(null);
    if (hit.kind === "music") {
      void submitRequest(hit);
      return;
    }
    setDraft({
      hit,
      seasonMode: "all",
      rootFolderId: null,
      folders: [],
      foldersLoading: true,
      foldersError: null,
    });
    void loadRootFolders(hit);
  };

  const submitRequest = async (
    hit: OmbiSearchHit,
    opts: {
      seasonMode?: SeasonMode;
      rootFolderId?: number | null;
      rootFolderPath?: string | null;
    } = {},
  ) => {
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
          seasonMode: opts.seasonMode,
          rootFolderId: opts.rootFolderId ?? undefined,
          rootFolderPath: opts.rootFolderPath ?? undefined,
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
      setDraft(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  };

  const confirmDraft = () => {
    if (!draft || draft.foldersLoading) return;
    const selected = draft.folders.find((f) => f.id === draft.rootFolderId);
    void submitRequest(draft.hit, {
      seasonMode: draft.seasonMode,
      rootFolderId: draft.rootFolderId,
      rootFolderPath: selected?.path ?? null,
    });
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
                Movies &amp; TV share one search. Pick seasons + root folder
                before sending. Music searches Lidarr albums.
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
                          disabled={busyKey != null || draft != null}
                          onClick={() => openRequestOptions(hit)}
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

      {draft ? (
        <div
          className="ombi-request-overlay"
          role="presentation"
          onClick={(e) => {
            e.stopPropagation();
            if (busyKey) return;
            setDraft(null);
          }}
        >
          <div
            className="ombi-request-dialog"
            role="dialog"
            aria-labelledby="ombi-request-title"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="ombi-request-title">Request options</h3>
            <p className="ombi-request-title-line">
              <span className="ombi-kind-badge">
                {ombiKindLabel(draft.hit.kind)}
              </span>{" "}
              {draft.hit.title}
              {draft.hit.year ? ` (${draft.hit.year})` : ""}
            </p>
            <p className="ombi-request-hint">
              {draft.hit.kind === "tv"
                ? "Pick first season or all seasons, then the Sonarr root folder (TV vs anime)."
                : "Pick the Radarr root folder (Movies vs Anime Movies)."}
            </p>

            {draft.hit.kind === "tv" ? (
              <fieldset className="ombi-request-fieldset">
                <legend>Seasons</legend>
                <label className="ombi-request-choice">
                  <input
                    type="radio"
                    name="ombi-season-mode"
                    checked={draft.seasonMode === "first"}
                    onChange={() =>
                      setDraft((prev) =>
                        prev ? { ...prev, seasonMode: "first" } : prev,
                      )
                    }
                    disabled={busyKey != null}
                  />
                  First season only
                </label>
                <label className="ombi-request-choice">
                  <input
                    type="radio"
                    name="ombi-season-mode"
                    checked={draft.seasonMode === "all"}
                    onChange={() =>
                      setDraft((prev) =>
                        prev ? { ...prev, seasonMode: "all" } : prev,
                      )
                    }
                    disabled={busyKey != null}
                  />
                  All seasons
                </label>
              </fieldset>
            ) : null}

            <label className="ombi-request-folder-label" htmlFor="ombi-root-folder">
              Root folder
            </label>
            {draft.foldersLoading ? (
              <p className="ombi-request-hint">Loading folders from Ombi…</p>
            ) : draft.folders.length > 0 ? (
              <select
                id="ombi-root-folder"
                className="ombi-request-select"
                value={draft.rootFolderId ?? ""}
                onChange={(e) => {
                  const id = Number(e.target.value);
                  setDraft((prev) =>
                    prev
                      ? {
                          ...prev,
                          rootFolderId: Number.isFinite(id) ? id : null,
                        }
                      : prev,
                  );
                }}
                disabled={busyKey != null}
              >
                {draft.folders.map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {folderLabel(folder)}
                  </option>
                ))}
              </select>
            ) : (
              <p className="ombi-request-hint">
                {draft.foldersError ||
                  "No root folders listed — Ombi default will be used."}
              </p>
            )}

            <div className="ombi-request-actions">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busyKey != null}
                onClick={() => setDraft(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busyKey != null || draft.foldersLoading}
                onClick={confirmDraft}
              >
                {busyKey === draft.hit.key ? "Requesting…" : "Send request"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
