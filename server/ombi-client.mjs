/**
 * Ombi API helpers for search / request / deny.
 * All media search & request go through Ombi — never Sonarr/Radarr/Lidarr directly.
 */

export function normalizeOmbiBase(url) {
  return String(url || "")
    .trim()
    .replace(/\/+$/, "");
}

function asObject(data) {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return data;
  }
  return {};
}

function asArray(data) {
  return Array.isArray(data) ? data : [];
}

function posterUrl(raw) {
  const path = typeof raw === "string" ? raw.trim() : "";
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  const cleaned = path.startsWith("/") ? path : `/${path}`;
  return `https://image.tmdb.org/t/p/w154${cleaned}`;
}

function yearFromDate(raw) {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return "";
  const m = /^(\d{4})/.exec(s);
  return m ? m[1] : "";
}

function numId(raw) {
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Ombi's SearchArtistViewModel misspells the field as `ForignArtistId`
 * (missing 'e'). Accept both spellings so artist results aren't dropped.
 */
export function readForeignArtistId(row) {
  if (!row || typeof row !== "object") return "";
  return String(
    row.foreignArtistId ||
      row.forignArtistId ||
      row.ForeignArtistId ||
      row.ForignArtistId ||
      row.id ||
      row.artistId ||
      "",
  ).trim();
}

export function mapMovieHit(row) {
  if (!row || typeof row !== "object") return null;
  const tmdbId = numId(row.id) ?? numId(row.theMovieDbId);
  const title = String(row.title || row.name || "").trim();
  if (!title || !tmdbId) return null;
  return {
    key: `movie-${tmdbId}`,
    kind: "movie",
    title,
    year: yearFromDate(row.releaseDate),
    overview: String(row.overview || "").trim(),
    posterUrl: posterUrl(row.posterPath),
    tmdbId,
    tvdbId: null,
    foreignArtistId: null,
    foreignAlbumId: null,
    available: row.available === true,
    requested: row.requested === true,
    approved: row.approved === true,
  };
}

export function mapTvHit(row) {
  if (!row || typeof row !== "object") return null;
  const tvdbId = numId(row.id) ?? numId(row.tvDbId) ?? numId(row.tvdbId);
  const tmdbId = numId(row.theMovieDbId) ?? numId(row.tmdbId);
  const title = String(row.title || row.name || "").trim();
  if (!title || (!tvdbId && !tmdbId)) return null;
  return {
    key: `tv-${tvdbId || tmdbId}`,
    kind: "tv",
    title,
    year: yearFromDate(row.firstAired || row.releaseDate),
    overview: String(row.overview || "").trim(),
    posterUrl: posterUrl(row.posterPath),
    tmdbId,
    tvdbId,
    foreignArtistId: null,
    foreignAlbumId: null,
    available:
      row.available === true ||
      row.fullyAvailable === true ||
      row.partlyAvailable === true,
    requested: row.requested === true,
    approved: row.approved === true,
  };
}

export function mapMusicArtistHit(row) {
  if (!row || typeof row !== "object") return null;
  const foreignArtistId = readForeignArtistId(row);
  const title = String(
    row.artistName || row.name || row.title || "",
  ).trim();
  if (!title || !foreignArtistId) return null;
  return {
    key: `music-artist-${foreignArtistId}`,
    kind: "music",
    title,
    year: "",
    overview: String(row.overview || row.disambiguation || "").trim(),
    posterUrl: posterUrl(row.poster || row.posterPath || row.banner || row.cover),
    tmdbId: null,
    tvdbId: null,
    foreignArtistId,
    foreignAlbumId: null,
    available: row.available === true || row.monitored === true,
    requested: row.requested === true,
    approved: row.approved === true,
  };
}

/** Album hits are what Ombi can actually request (foreignAlbumId). */
export function mapMusicAlbumHit(row) {
  if (!row || typeof row !== "object") return null;
  const foreignAlbumId = String(row.foreignAlbumId || row.id || "").trim();
  const albumTitle = String(row.title || row.name || "").trim();
  const artistName = String(row.artistName || "").trim();
  if (!albumTitle || !foreignAlbumId) return null;
  const foreignArtistId = readForeignArtistId(row) || null;
  return {
    key: `music-album-${foreignAlbumId}`,
    kind: "music",
    title: artistName ? `${artistName} — ${albumTitle}` : albumTitle,
    year: yearFromDate(row.releaseDate),
    overview: String(row.albumType || row.overview || "").trim(),
    posterUrl: posterUrl(row.cover || row.disk || row.poster || row.posterPath),
    tmdbId: null,
    tvdbId: null,
    foreignArtistId,
    foreignAlbumId,
    available:
      row.available === true ||
      row.fullyAvailable === true ||
      row.monitored === true,
    requested: row.requested === true,
    approved: row.approved === true,
  };
}

/** Movies first, then TV; keep provider order within each kind. */
export function mergeMediaSearchHits(movieHits, tvHits) {
  const hits = [...(movieHits || []), ...(tvHits || [])];
  hits.sort((a, b) => {
    if (a.kind === b.kind) return 0;
    return a.kind === "movie" ? -1 : 1;
  });
  return hits;
}

export function ombiHitStatusLabel(hit) {
  if (!hit) return "Not requested";
  if (hit.available) return "Available";
  if (hit.approved) return "Approved";
  if (hit.requested) return "Requested";
  return "Not requested";
}

export function ombiKindLabel(kind) {
  if (kind === "movie") return "Movie";
  if (kind === "tv") return "TV";
  return "Music";
}

export function assertOmbiOk(status, data, fallback) {
  if (status >= 200 && status < 300) {
    const json = asObject(data);
    if (json.isError === true || json.result === false) {
      const msg =
        (typeof json.errorMessage === "string" && json.errorMessage.trim()) ||
        (typeof json.message === "string" && json.message.trim()) ||
        fallback;
      const err = new Error(msg);
      err.status = 502;
      throw err;
    }
    return;
  }
  const json = asObject(data);
  const msg =
    (typeof json.errorMessage === "string" && json.errorMessage.trim()) ||
    (typeof json.message === "string" && json.message.trim()) ||
    (typeof json.error === "string" && json.error.trim()) ||
    `${fallback} (HTTP ${status})`;
  const err = new Error(msg);
  err.status = status >= 400 && status < 600 ? status : 502;
  throw err;
}

/**
 * Build Ombi request body + path for a normalized search hit.
 * Throws if the hit cannot be requested (e.g. artist-only music).
 */
export function buildOmbiRequestPayload(hit) {
  if (!hit || typeof hit !== "object") {
    const err = new Error("Missing request payload");
    err.status = 400;
    throw err;
  }
  if (hit.available) {
    const err = new Error("Already available in the library.");
    err.status = 400;
    throw err;
  }
  if (hit.requested || hit.approved) {
    const err = new Error("Already requested in Ombi.");
    err.status = 400;
    throw err;
  }

  const kind = String(hit.kind || "").toLowerCase();
  if (kind === "movie") {
    const tmdbId = numId(hit.tmdbId);
    if (!tmdbId) {
      const err = new Error("Missing TMDb id for this movie.");
      err.status = 400;
      throw err;
    }
    return {
      path: "/api/v1/Request/movie",
      body: { theMovieDbId: tmdbId },
      message: `Requested “${hit.title}” via Ombi → Radarr.`,
    };
  }

  if (kind === "tv") {
    const tvdbId = numId(hit.tvdbId);
    const tmdbId = numId(hit.tmdbId);
    const body = { requestAll: true };
    if (tvdbId) body.tvDbId = tvdbId;
    else if (tmdbId) body.theMovieDbId = tmdbId;
    else {
      const err = new Error("Missing TVDB/TMDb id for this show.");
      err.status = 400;
      throw err;
    }
    return {
      path: "/api/v1/Request/tv",
      body,
      message: `Requested “${hit.title}” (all seasons) via Ombi → Sonarr.`,
    };
  }

  if (kind === "music") {
    const foreignAlbumId = String(hit.foreignAlbumId || "").trim();
    if (!foreignAlbumId) {
      const err = new Error(
        "Pick an album to request (Ombi music requests are album-based). Search by album title, or open Ombi web to browse an artist’s albums.",
      );
      err.status = 400;
      throw err;
    }
    return {
      path: "/api/v1/Request/music",
      body: { foreignAlbumId },
      message: `Requested “${hit.title}” via Ombi → Lidarr.`,
    };
  }

  const err = new Error("kind must be movie, tv, or music");
  err.status = 400;
  throw err;
}

export function ombiDenyPath(type) {
  const t = String(type || "").toLowerCase();
  const pathByType = {
    movie: "movie/deny",
    tv: "tv/deny",
    music: "music/deny",
  };
  return pathByType[t] || null;
}

export function ombiApprovePath(type) {
  const t = String(type || "").toLowerCase();
  const pathByType = {
    movie: "movie/approve",
    tv: "tv/approve",
    music: "music/approve",
  };
  return pathByType[t] || null;
}

/**
 * Low-level Ombi HTTP. Returns { status, data } without throwing on HTTP errors.
 */
export async function ombiHttp(baseUrl, apiKey, path, options = {}) {
  const base = normalizeOmbiBase(baseUrl);
  if (!base || !apiKey) {
    const err = new Error("Ombi is not configured (URL + API key)");
    err.status = 400;
    throw err;
  }
  const method = options.method || "GET";
  const timeoutMs = options.timeoutMs ?? 20000;
  const headers = {
    ApiKey: apiKey,
    Accept: "application/json",
    ...(options.body != null
      ? { "Content-Type": "application/json" }
      : {}),
    ...(options.headers || {}),
  };
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body:
      options.body != null ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

function mapRows(rows, mapper) {
  const hits = [];
  for (const raw of asArray(rows)) {
    if (!raw || typeof raw !== "object") continue;
    const hit = mapper(raw);
    if (hit) hits.push(hit);
  }
  return hits;
}

async function searchKind(baseUrl, apiKey, kind, query) {
  const encoded = encodeURIComponent(query);
  const path =
    kind === "movie"
      ? `/api/v1/Search/movie/${encoded}`
      : kind === "tv"
        ? `/api/v1/Search/tv/${encoded}`
        : `/api/v1/Search/music/album/${encoded}`;
  const { status, data } = await ombiHttp(baseUrl, apiKey, path, {
    timeoutMs: 25000,
  });
  if (status < 200 || status >= 300) {
    assertOmbiOk(status, data, "Ombi search failed");
  }
  const mapper =
    kind === "movie"
      ? mapMovieHit
      : kind === "tv"
        ? mapTvHit
        : mapMusicAlbumHit;
  return mapRows(data, mapper);
}

async function searchMusic(baseUrl, apiKey, query) {
  const albums = await searchKind(baseUrl, apiKey, "music", query);
  if (albums.length > 0) return albums;

  const encoded = encodeURIComponent(query);
  const { status, data } = await ombiHttp(
    baseUrl,
    apiKey,
    `/api/v1/Search/music/artist/${encoded}`,
    { timeoutMs: 25000 },
  );
  if (status < 200 || status >= 300) {
    assertOmbiOk(status, data, "Ombi music search failed");
  }
  return mapRows(data, mapMusicArtistHit);
}

/**
 * Search Ombi. `media` = movies + TV in parallel; `music` = albums then artists.
 */
export async function searchOmbi(baseUrl, apiKey, mode, query) {
  const q = String(query || "").trim();
  if (q.length < 2) {
    const err = new Error("Enter at least 2 characters to search.");
    err.status = 400;
    throw err;
  }

  const m = String(mode || "media").toLowerCase();
  if (m === "music") {
    return searchMusic(baseUrl, apiKey, q);
  }

  const settled = await Promise.allSettled([
    searchKind(baseUrl, apiKey, "movie", q),
    searchKind(baseUrl, apiKey, "tv", q),
  ]);

  const movieHits =
    settled[0].status === "fulfilled" ? settled[0].value : [];
  const tvHits =
    settled[1].status === "fulfilled" ? settled[1].value : [];
  const hits = mergeMediaSearchHits(movieHits, tvHits);

  if (!hits.length) {
    const errors = [];
    for (const result of settled) {
      if (result.status === "rejected") {
        errors.push(
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
        );
      }
    }
    if (errors.length) {
      const err = new Error(errors[0] || "Ombi search failed");
      err.status = 502;
      throw err;
    }
  }

  return hits;
}

export async function requestOmbiMedia(baseUrl, apiKey, hit) {
  const payload = buildOmbiRequestPayload(hit);
  const { status, data } = await ombiHttp(baseUrl, apiKey, payload.path, {
    method: "POST",
    body: payload.body,
  });
  assertOmbiOk(status, data, "Request failed");
  return { ok: true, message: payload.message, ombi: data ?? null };
}
