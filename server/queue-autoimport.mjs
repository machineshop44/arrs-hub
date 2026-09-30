import { getArrApiKey } from "./arr-api-keys.mjs";
import { createServiceUrlResolver } from "./url-policy.mjs";

/** Queue messages that mean "the app wants a human to confirm the import". */
const MANUAL_IMPORT_MSG =
  /manual import|matched to (series|movie) by id|automatic import is not possible|was unexpected considering|unable to determine|not found in grab history|import (is )?blocked/i;

export const AUTO_IMPORT_APPS = new Set(["sonarr", "radarr"]);

/** importPending with no message = the app is about to import on its own (see health-autofix nudge). */
export function needsManualImport(issue) {
  const state = String(issue?.trackedDownloadState || "").toLowerCase();
  const msg = String(issue?.errorMessage || "");
  return MANUAL_IMPORT_MSG.test(msg) || (Boolean(msg) && (state === "importpending" || state === "importblocked"));
}

/** "The Office (US)" / "Marvel's Agents of S.H.I.E.L.D." → comparable token string. */
export function normTitle(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\(\d{4}\)/g, " ")
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/^(the|a|an) /, "")
    .trim()
    .replace(/ /g, "");
}

function fileBaseName(p) {
  return String(p || "").split(/[\\/]/).pop() || "";
}

function hasEpisodeTag(name, season, episode) {
  const s = Number(season);
  const e = Number(episode);
  if (!Number.isInteger(s) || !Number.isInteger(e)) return false;
  const sxe = new RegExp(`(^|[^a-z0-9])s0*${s}[ ._-]?e0*${e}(?!\\d)`, "i");
  const nxn = new RegExp(`(^|[^0-9])${s}x0*${e}(?!\\d)`, "i");
  // Multi-episode files: S01E01E02 / S01E01-E02 — each extra episode appears as E0n.
  const extra = new RegExp(`(^|[^a-z0-9])s0*${s}(e\\d+[ ._-]?)*[ ._-]?e0*${e}(?!\\d)`, "i");
  return sxe.test(name) || nxn.test(name) || extra.test(name);
}

/**
 * File name must contain the series title and every episode's SxxEyy tag.
 * @param {string} filePath
 * @param {{ title?: string }} series
 * @param {{ seasonNumber: number, episodeNumber: number }[]} episodes
 */
export function fileMatchesSeries(filePath, series, episodes) {
  const name = fileBaseName(filePath);
  const title = normTitle(series?.title);
  if (!title || !normTitle(name).includes(title)) return false;
  if (!Array.isArray(episodes) || episodes.length === 0) return false;
  return episodes.every((ep) => hasEpisodeTag(name, ep.seasonNumber, ep.episodeNumber));
}

/**
 * File name must contain the movie title and (when known) its year.
 * @param {string} filePath
 * @param {{ title?: string, year?: number }} movie
 */
export function fileMatchesMovie(filePath, movie) {
  const name = fileBaseName(filePath);
  const title = normTitle(movie?.title);
  if (!title || !normTitle(name).includes(title)) return false;
  const year = Number(movie?.year);
  return !year || name.includes(String(year));
}

function isSampleOnlyRejection(candidate) {
  const rejections = Array.isArray(candidate?.rejections) ? candidate.rejections : [];
  return rejections.length > 0 && rejections.every((r) => /sample/i.test(String(r?.reason || r || "")));
}

/**
 * Decide which manual-import candidates are safe to accept. Any doubt → null (leave for a human).
 * @param {"sonarr" | "radarr"} app
 * @param {object[]} candidates GET /manualimport result
 * @param {{ seriesId?: number | null, movieId?: number | null, episodeIds: Set<number> }} expected from the queue
 * @returns {{ files: object[] } | { reason: string }}
 */
export function planAutoImport(app, candidates, expected) {
  const list = (Array.isArray(candidates) ? candidates : []).filter((c) => !isSampleOnlyRejection(c));
  if (list.length === 0) return { reason: "no importable files" };
  const files = [];
  for (const c of list) {
    if (Array.isArray(c.rejections) && c.rejections.length > 0) {
      return { reason: `rejected: ${String(c.rejections[0]?.reason || c.rejections[0])}` };
    }
    if (!c.quality) return { reason: "unknown quality" };
    if (app === "sonarr") {
      const episodes = Array.isArray(c.episodes) ? c.episodes : [];
      if (!c.series?.id || c.series.id !== expected.seriesId) return { reason: "series mismatch" };
      if (!episodes.length || !episodes.every((ep) => expected.episodeIds.has(ep.id))) {
        return { reason: "episodes differ from the grab" };
      }
      if (!fileMatchesSeries(c.path, c.series, episodes)) return { reason: "file name does not match" };
      files.push({
        path: c.path,
        folderName: c.folderName,
        seriesId: c.series.id,
        episodeIds: episodes.map((ep) => ep.id),
        quality: c.quality,
        languages: c.languages,
        releaseGroup: c.releaseGroup,
        indexerFlags: c.indexerFlags,
        releaseType: c.releaseType,
        downloadId: c.downloadId,
      });
    } else {
      if (!c.movie?.id || c.movie.id !== expected.movieId) return { reason: "movie mismatch" };
      if (!fileMatchesMovie(c.path, c.movie)) return { reason: "file name does not match" };
      files.push({
        path: c.path,
        folderName: c.folderName,
        movieId: c.movie.id,
        quality: c.quality,
        languages: c.languages,
        releaseGroup: c.releaseGroup,
        indexerFlags: c.indexerFlags,
        downloadId: c.downloadId,
      });
    }
  }
  return { files };
}

async function arrFetch(base, apiKey, pathAndQuery, init = {}) {
  const res = await fetch(`${base}/api/v3${pathAndQuery}`, {
    ...init,
    headers: { "X-Api-Key": apiKey, Accept: "application/json", "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 160)}` : ""}`);
  return text ? JSON.parse(text) : null;
}

/**
 * Accept a manual import when every file's name matches what the app grabbed.
 * "auto" import mode = hardlink/copy for torrents (keeps seeding), move for usenet.
 * @param {"sonarr" | "radarr"} app
 * @param {{ downloadId: string, seriesId?: number | null, movieId?: number | null, episodeIds: Set<number> }} group
 * @param {ReturnType<typeof createServiceUrlResolver>} [resolver]
 * @returns {Promise<{ imported: number } | { skipped: string }>}
 */
export async function autoImportDownload(app, group, resolver) {
  const r = resolver || createServiceUrlResolver({ urls: {} });
  const base = String(r.resolve(app) || "").trim().replace(/\/+$/, "");
  const apiKey = getArrApiKey(app);
  if (!base || !apiKey) return { skipped: "not configured" };
  const qs = new URLSearchParams({ downloadId: group.downloadId, filterExistingFiles: "true" });
  const candidates = await arrFetch(base, apiKey, `/manualimport?${qs}`);
  const plan = planAutoImport(app, candidates, group);
  if (!("files" in plan)) return { skipped: plan.reason };
  await arrFetch(base, apiKey, "/command", {
    method: "POST",
    body: JSON.stringify({ name: "ManualImport", importMode: "auto", files: plan.files }),
  });
  return { imported: plan.files.length };
}
