import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, ensureDataDirs } from "./config.mjs";
import {
  arrCommand,
  arrConn,
  arrGet,
  fetchArrQueueRecords,
  getJson,
  importedBy,
  qbSession,
  queueMessages,
  refreshImportedHashes,
  sabApi,
} from "./download-clients.mjs";
import { loadIntegrationsSettings } from "./integrations.mjs";
import { normalizeOmbiBase, ombiHttp } from "./ombi-client.mjs";
import { getWorkoutConfig, listLibraryLocations, refreshLibraryPath } from "./plex.mjs";
import { removeArrQueueItem } from "./queue-actions.mjs";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Daily caps for searches the Hub starts on its own. */
const SEARCH_CAP = { sonarr: 8, radarr: 3, lidarr: 2 };
const OMBI_LOOKUPS_MAX = 20;

const VANISHED_MSG =
  /(no longer|wasn'?t|was not|not) (be )?(found|available|present)? ?in (the )?download client|removed from (the )?download client/i;
const PARTIAL_PACK_MSG = /were not imported|expected in this release|not all (files|episodes)/i;

function errText(err) {
  return err instanceof Error ? err.message : String(err);
}

function fixResult(now, fields) {
  return { blocklist: false, keptSeeding: false, at: new Date(now).toISOString(), ok: true, ...fields };
}

const pad = (n) => String(n).padStart(2, "0");

/**
 * Queue items whose download is gone from the client. Only judged when that
 * client was readable (a null list means "unknown", never "gone").
 * @param {Record<string, object[]>} queues raw *arr queue records
 * @param {Set<string> | null} qbHashes
 * @param {Set<string> | null} sabIds
 */
export function pickVanished(queues, qbHashes, sabIds) {
  const out = [];
  for (const [app, records] of Object.entries(queues || {})) {
    for (const r of records) {
      if (!r?.id || !VANISHED_MSG.test(queueMessages(r))) continue;
      const id = String(r.downloadId || "").toLowerCase();
      const torrent = String(r.protocol || "").toLowerCase() === "torrent";
      const list = torrent ? qbHashes : sabIds;
      if (!id || !list || list.has(id)) continue;
      out.push({ app, record: r });
    }
  }
  return out;
}

/**
 * Monitored, missing, released more than a day ago, never searched, not downloading.
 * Items without a `lastSearchTime` field (older *arr versions) are skipped.
 * @param {{ id: number, monitored?: boolean, hasFile?: boolean, lastSearchTime?: string | null, date?: string }[]} items
 * @param {Set<number>} queuedIds
 * @param {number} now
 * @param {number} cap
 */
export function pickNeverSearched(items, queuedIds, now, cap) {
  return (items || [])
    .filter(
      (i) =>
        i?.id &&
        i.monitored !== false &&
        !i.hasFile &&
        "lastSearchTime" in i &&
        !i.lastSearchTime &&
        !queuedIds.has(i.id) &&
        i.date &&
        now - Date.parse(i.date) > DAY_MS,
    )
    .slice(0, cap);
}

async function readClientIds(resolver) {
  let qbHashes = null;
  let sabIds = null;
  try {
    const session = await qbSession(resolver);
    if (session) {
      const list = await getJson(`${session.base}/api/v2/torrents/info`, session.headers, 30_000);
      if (Array.isArray(list)) qbHashes = new Set(list.map((t) => String(t?.hash || "").toLowerCase()));
    }
  } catch {
    qbHashes = null;
  }
  try {
    const api = sabApi(resolver);
    if (api) {
      const [q, h] = await Promise.all([getJson(api({ mode: "queue" })), getJson(api({ mode: "history", limit: "500" }))]);
      const ids = [...(q?.queue?.slots || []), ...(h?.history?.slots || [])].map((s) => String(s?.nzo_id || "").toLowerCase());
      sabIds = new Set(ids.filter(Boolean));
    }
  } catch {
    sabIds = null;
  }
  return { qbHashes, sabIds };
}

async function searchNeverSearched(resolver, queues, now, used) {
  const results = [];
  const queued = (app, field) => new Set((queues[app] || []).map((r) => Number(r?.[field])).filter(Boolean));

  const sonarr = arrConn(resolver, "sonarr");
  if (sonarr && used.sonarr < SEARCH_CAP.sonarr) {
    const data = await arrGet(sonarr, "/wanted/missing?page=1&pageSize=250&sortKey=airDateUtc&sortDirection=descending&monitored=true&includeSeries=true");
    const items = (data?.records || []).map((e) => ({ ...e, date: e.airDateUtc }));
    const picks = pickNeverSearched(items, queued("sonarr", "episodeId"), now, SEARCH_CAP.sonarr - used.sonarr);
    if (picks.length) {
      used.sonarr += picks.length;
      const names = picks.map((e) => `${e.series?.title || "Episode"} S${pad(e.seasonNumber)}E${pad(e.episodeNumber)}`);
      await pushCommand(results, sonarr, "sonarr", { name: "EpisodeSearch", episodeIds: picks.map((e) => e.id) }, names, now, "never searched");
    }
  }
  const radarr = arrConn(resolver, "radarr");
  if (radarr) {
    const movies = await arrGet(radarr, "/movie", 60_000);
    const items = (Array.isArray(movies) ? movies : [])
      .filter((m) => m.isAvailable !== false && (!m.status || m.status === "released"))
      .map((m) => ({ ...m, date: m.added }));
    const picks = pickNeverSearched(items, queued("radarr", "movieId"), now, SEARCH_CAP.radarr);
    if (picks.length) {
      const names = picks.map((m) => `${m.title}${m.year ? ` (${m.year})` : ""}`);
      await pushCommand(results, radarr, "radarr", { name: "MoviesSearch", movieIds: picks.map((m) => m.id) }, names, now, "never searched");
    }
  }
  const lidarr = arrConn(resolver, "lidarr");
  if (lidarr) {
    const data = await arrGet(lidarr, "/wanted/missing?page=1&pageSize=100&monitored=true&includeArtist=true");
    const items = (data?.records || []).map((a) => ({ ...a, date: a.releaseDate }));
    const picks = pickNeverSearched(items, queued("lidarr", "albumId"), now, SEARCH_CAP.lidarr);
    if (picks.length) {
      const names = picks.map((a) => `${a.artist?.artistName ? `${a.artist.artistName} — ` : ""}${a.title}`);
      await pushCommand(results, lidarr, "lidarr", { name: "AlbumSearch", albumIds: picks.map((a) => a.id) }, names, now, "never searched");
    }
  }
  return results;
}

async function pushCommand(results, conn, app, body, names, now, why) {
  const base = {
    key: `search:${app}:${body.name}`,
    app,
    rule: "searchMissing",
    title: names.length === 1 ? names[0] : `${names.length} items`,
  };
  try {
    await arrCommand(conn, body);
    results.push(fixResult(now, { ...base, reason: `${why} → search started${names.length > 1 ? `: ${names.slice(0, 5).join(", ")}${names.length > 5 ? "…" : ""}` : ""}` }));
  } catch (err) {
    results.push(fixResult(now, { ...base, reason: "search", ok: false, error: errText(err) }));
  }
}

/** Season pack imported some episodes and stopped: search only the still-missing ones. */
async function searchPartialPacks(resolver, queues, now, used) {
  const sonarr = arrConn(resolver, "sonarr");
  if (!sonarr || used.sonarr >= SEARCH_CAP.sonarr) return [];
  const leftover = new Set();
  for (const r of queues.sonarr || []) {
    const id = String(r?.downloadId || "").toLowerCase();
    if (r?.episodeId && importedBy.get(id) === "sonarr" && PARTIAL_PACK_MSG.test(queueMessages(r))) leftover.add(Number(r.episodeId));
  }
  if (!leftover.size) return [];
  const qs = [...leftover].map((id) => `episodeIds=${id}`).join("&");
  const eps = await arrGet(sonarr, `/episode?${qs}&includeSeries=true`);
  const picks = (Array.isArray(eps) ? eps : [])
    .filter((e) => e.monitored !== false && !e.hasFile)
    .slice(0, SEARCH_CAP.sonarr - used.sonarr);
  if (!picks.length) return [];
  used.sonarr += picks.length;
  const names = picks.map((e) => `${e.series?.title || "Episode"} S${pad(e.seasonNumber)}E${pad(e.episodeNumber)}`);
  const results = [];
  await pushCommand(results, sonarr, "sonarr", { name: "EpisodeSearch", episodeIds: picks.map((e) => e.id) }, names, now, "missing from a season pack that only partly imported");
  for (const r of results) r.rule = "seasonPack";
  return results;
}

/** Approved Ombi requests the *arrs already have files for → mark available. */
async function markOmbiAvailable(resolver, now) {
  const base = normalizeOmbiBase(resolver.resolve("ombi"));
  const apiKey = String(loadIntegrationsSettings().ombi?.apiKey || "").trim();
  if (!base || !apiKey) return [];
  const results = [];
  let lookups = 0;
  const waiting = (row) => row && row.approved === true && row.available !== true && row.denied !== true && !row.deniedDate &&
    (!row.requestedDate || now - Date.parse(row.requestedDate) > HOUR_MS);
  const mark = async (type, id, title, why) => {
    const { status, data } = await ombiHttp(base, apiKey, `/api/v1/Request/${type}/available`, { method: "POST", body: { id } });
    const ok = status >= 200 && status < 300 && data?.isError !== true;
    results.push(
      fixResult(now, {
        key: `ombi:${type}:${id}`,
        app: "ombi",
        rule: "ombiAvailable",
        title,
        reason: `${why} → marked available in Ombi`,
        ok,
        ...(ok ? {} : { error: String(data?.errorMessage || data?.message || `HTTP ${status}`) }),
      }),
    );
  };

  const radarr = arrConn(resolver, "radarr");
  if (radarr) {
    const { data: movies } = await ombiHttp(base, apiKey, "/api/v1/Request/movie");
    for (const row of (Array.isArray(movies) ? movies : []).filter(waiting)) {
      if (!row.theMovieDbId || lookups++ >= OMBI_LOOKUPS_MAX) continue;
      const found = await arrGet(radarr, `/movie?tmdbId=${row.theMovieDbId}`).catch(() => null);
      if ((Array.isArray(found) ? found : []).some((m) => m.hasFile)) await mark("movie", row.id, String(row.title || "Movie"), "Radarr has the file");
    }
  }

  const sonarr = arrConn(resolver, "sonarr");
  if (sonarr) {
    const { data: shows } = await ombiHttp(base, apiKey, "/api/v1/Request/tv");
    for (const parent of Array.isArray(shows) ? shows : []) {
      const children = (parent?.childRequests || []).filter(waiting);
      if (!children.length || !parent.tvDbId || lookups++ >= OMBI_LOOKUPS_MAX) continue;
      const series = await arrGet(sonarr, `/series?tvdbId=${parent.tvDbId}`).catch(() => null);
      const seriesId = (Array.isArray(series) ? series : [])[0]?.id;
      if (!seriesId) continue;
      const eps = await arrGet(sonarr, `/episode?seriesId=${seriesId}`).catch(() => null);
      const have = new Set((Array.isArray(eps) ? eps : []).filter((e) => e.hasFile).map((e) => `${e.seasonNumber}x${e.episodeNumber}`));
      for (const child of children) {
        const wanted = (child.seasonRequests || []).flatMap((s) => (s.episodes || []).map((e) => `${s.seasonNumber}x${e.episodeNumber}`));
        if (wanted.length && wanted.every((k) => have.has(k))) {
          await mark("tv", child.id, String(parent.title || "Series"), `Sonarr has all ${wanted.length} requested episode${wanted.length === 1 ? "" : "s"}`);
        }
      }
    }
  }
  return results;
}

/**
 * Daily *arr pass: clear queue items whose download vanished, search monitored
 * items that were never searched (capped), search episodes a season pack left
 * behind, and mark Ombi requests available once the files exist.
 */
export async function runArrPass(resolver, settings, now, snapshot) {
  const wantsQueue = settings.autoFixVanished !== false || settings.autoFixSeasonPack !== false || settings.autoFixSearchNeverSearched !== false;
  const results = [];
  if (wantsQueue) {
    const [queues] = await Promise.all([fetchArrQueueRecords(resolver), refreshImportedHashes(resolver)]);
    if (!queues) throw new Error("an *arr queue could not be read");

    if (settings.autoFixVanished !== false) {
      const { qbHashes, sabIds } = await readClientIds(resolver);
      for (const { app, record } of pickVanished(queues, qbHashes, sabIds)) {
        const base = {
          key: `queue:${app}:${record.id}`,
          app,
          rule: "vanished",
          title: String(record.title || "Unknown item"),
          reason: `download is gone from ${String(record.protocol).toLowerCase() === "torrent" ? "qBittorrent" : "SABnzbd"}`,
        };
        try {
          await removeArrQueueItem({ app, id: record.id, blocklist: false, removeFromClient: false });
          results.push(fixResult(now, base));
        } catch (err) {
          results.push(fixResult(now, { ...base, ok: false, error: errText(err) }));
        }
      }
    }

    // Searching adds downloads: hold off while a drive is low on space.
    const diskLow = (snapshot?.disk?.low || []).length > 0;
    const used = { sonarr: 0 };
    if (settings.autoFixSeasonPack !== false && !diskLow) {
      try {
        results.push(...(await searchPartialPacks(resolver, queues, now, used)));
      } catch (err) {
        console.warn("[stack-autofix] season packs:", errText(err));
      }
    }
    if (settings.autoFixSearchNeverSearched !== false && !diskLow) {
      try {
        results.push(...(await searchNeverSearched(resolver, queues, now, used)));
      } catch (err) {
        console.warn("[stack-autofix] never searched:", errText(err));
      }
    }
  }
  if (settings.autoFixOmbiAvailable !== false) {
    try {
      results.push(...(await markOmbiAvailable(resolver, now)));
    } catch (err) {
      console.warn("[stack-autofix] Ombi:", errText(err));
    }
  }
  return results;
}

const PLEX_STATE_FILE = path.join(DATA_DIR, "plex-refresh.json");
const PLEX_IMPORT_EVENT = { sonarr: 3, radarr: 3, lidarr: 3 };

function normPath(p) {
  return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Group recent imports by Plex library + parent folder, skipping folders Plex
 * already scanned after the import or libraries that are scanning now.
 * @param {{ path: string, date: number }[]} imports importedPath + epoch ms
 * @param {{ id: string, title: string, scannedAt: number, refreshing: boolean, locations: string[] }[]} sections
 */
export function planPlexRefreshes(imports, sections) {
  const plans = new Map();
  for (const imp of imports) {
    const file = String(imp.path || "").replace(/\\/g, "/");
    const folder = file.slice(0, file.lastIndexOf("/"));
    if (!folder) continue;
    const section = sections.find((s) => s.locations.some((loc) => normPath(file).startsWith(`${normPath(loc)}/`)));
    if (!section || section.refreshing || section.scannedAt * 1000 >= imp.date) continue;
    const key = `${section.id}|${normPath(folder)}`;
    if (!plans.has(key)) {
      const sep = String(imp.path).includes("\\") ? "\\" : "/";
      plans.set(key, { section, folder: folder.split("/").join(sep) });
    }
  }
  return [...plans.values()];
}

/** Every scan: refresh just the Plex folders the *arrs imported into since last time. */
export async function runPlexRefresh(resolver, settings, now = Date.now()) {
  if (settings.autoFixEnabled === false || settings.autoFixPlexRefresh === false) return [];
  const plex = getWorkoutConfig();
  if (!plex.plexToken?.trim() || !plex.plexBaseUrl) return [];
  let since = now - HOUR_MS;
  try {
    since = Math.max(now - DAY_MS, Date.parse(JSON.parse(fs.readFileSync(PLEX_STATE_FILE, "utf8")).since) || since);
  } catch {
    /* first run: look back an hour */
  }
  const imports = [];
  await Promise.all(
    Object.entries(PLEX_IMPORT_EVENT).map(async ([app, eventType]) => {
      const conn = arrConn(resolver, app);
      if (!conn) return;
      try {
        const rows = await arrGet(conn, `/history/since?date=${encodeURIComponent(new Date(since).toISOString())}&eventType=${eventType}`);
        for (const r of Array.isArray(rows) ? rows : []) {
          const p = r?.data?.importedPath;
          if (p) imports.push({ path: p, date: Date.parse(r.date) || now, app });
        }
      } catch {
        /* skipped this scan */
      }
    }),
  );
  ensureDataDirs();
  fs.writeFileSync(PLEX_STATE_FILE, JSON.stringify({ since: new Date(now).toISOString() }));
  if (!imports.length) return [];
  const sections = await listLibraryLocations(plex);
  const results = [];
  for (const { section, folder } of planPlexRefreshes(imports, sections).slice(0, 20)) {
    const base = { key: `plex:${section.id}:${normPath(folder)}`, app: "plex", rule: "plexRefresh", title: folder.split(/[\\/]/).pop() || folder };
    try {
      await refreshLibraryPath(section.id, folder, plex);
      results.push(fixResult(now, { ...base, reason: `new import → scanned that folder in Plex (${section.title})` }));
    } catch (err) {
      results.push(fixResult(now, { ...base, reason: "Plex scan", ok: false, error: errText(err) }));
    }
  }
  return results;
}