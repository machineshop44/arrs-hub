import test from "node:test";
import assert from "node:assert/strict";
import {
  fileMatchesMovie,
  fileMatchesSeries,
  needsManualImport,
  normTitle,
  planAutoImport,
} from "./queue-autoimport.mjs";
import { classifyStalled, pickDuplicateLosers, runQueueAutoFix } from "./queue-autofix.mjs";

test("normTitle ignores case, punctuation, years and leading articles", () => {
  assert.equal(normTitle("The Office (US)"), normTitle("office us"));
  assert.equal(normTitle("Marvel's Agents of S.H.I.E.L.D."), "marvelsagentsofshield");
  assert.equal(normTitle("Law & Order"), normTitle("Law and Order"));
});

test("fileMatchesSeries requires title and every SxxEyy", () => {
  const series = { title: "The Last of Us" };
  const ep = (s, e) => ({ seasonNumber: s, episodeNumber: e });
  assert.equal(fileMatchesSeries("D:\\dl\\The.Last.of.Us.S01E03.1080p.WEB.mkv", series, [ep(1, 3)]), true);
  assert.equal(fileMatchesSeries("/dl/the last of us 1x03.mkv", series, [ep(1, 3)]), true);
  assert.equal(fileMatchesSeries("The.Last.of.Us.S01E01E02.mkv", series, [ep(1, 1), ep(1, 2)]), true);
  assert.equal(fileMatchesSeries("The.Last.of.Us.S01E13.mkv", series, [ep(1, 3)]), false, "E13 is not E3");
  assert.equal(fileMatchesSeries("The.Last.of.Us.S02E03.mkv", series, [ep(1, 3)]), false);
  assert.equal(fileMatchesSeries("abc123.mkv", series, [ep(1, 3)]), false, "obfuscated names stay manual");
  assert.equal(fileMatchesSeries("Last.Kingdom.S01E03.mkv", series, [ep(1, 3)]), false);
});

test("TBA-title blocks from real Sonarr messages are approved when names match", () => {
  const tba = "Episode has a TBA title and recently aired";
  assert.equal(needsManualImport({ errorMessage: tba }), true);

  const smarty = {
    path: "D:\\dl\\Smartypants.S03E09.Tax.the.Tall.1080p.DRPO.WEB-DL.AAC2.0.H.264-BLOOM.mkv",
    series: { id: 1, title: "Smartypants" },
    episodes: [{ id: 309, seasonNumber: 3, episodeNumber: 9 }],
    quality: {},
    rejections: [{ reason: tba, type: "permanent" }],
  };
  assert.equal(planAutoImport("sonarr", [smarty], { seriesId: 1, episodeIds: new Set([309]) }).files.length, 1);

  const sword = {
    path: "D:\\dl\\[SubsPlease] Tensei Shitara Ken Deshita S2 - 01 (1080p) [EA337770].mkv",
    series: {
      id: 2,
      title: "Reincarnated as a Sword",
      alternateTitles: [{ title: "Tensei Shitara Ken Deshita" }],
    },
    episodes: [{ id: 201, seasonNumber: 2, episodeNumber: 1, absoluteEpisodeNumber: 13 }],
    quality: {},
    rejections: [{ reason: tba }],
  };
  assert.equal(planAutoImport("sonarr", [sword], { seriesId: 2, episodeIds: new Set([201]) }).files.length, 1);
  assert.ok(
    planAutoImport("sonarr", [{ ...sword, rejections: [{ reason: tba }, { reason: "Not an upgrade" }] }], {
      seriesId: 2,
      episodeIds: new Set([201]),
    }).reason,
    "a real rejection alongside TBA still blocks",
  );
  assert.equal(
    fileMatchesSeries("[SubsPlease] Tensei Shitara Ken Deshita - 13 (1080p).mkv", sword.series, sword.episodes),
    true,
    "absolute numbering",
  );
  assert.equal(
    fileMatchesSeries("[SubsPlease] Tensei Shitara Ken Deshita S2 - 02 (1080p).mkv", sword.series, sword.episodes),
    false,
  );
});

test("pickDuplicateLosers keeps highest resolution, then CF score, and never drops season packs", () => {
  const rec = (id, dl, ep, resolution, cf, extra = {}) => ({
    id,
    title: `T${id}`,
    downloadId: dl,
    episodeId: ep,
    resolution,
    customFormatScore: cf,
    sizeleft: 0,
    ...extra,
  });
  let out = pickDuplicateLosers("sonarr", [rec(1, "a", 10, 720, 100), rec(2, "b", 10, 1080, 0), rec(3, "c", 10, 1080, 50)]);
  assert.deepEqual(out.map((o) => o.loser.id).sort(), [1, 2]);
  assert.equal(out[0].winner.id, 3);

  out = pickDuplicateLosers("sonarr", [rec(1, "pack", 10, 720, 0), rec(2, "pack", 11, 720, 0), rec(3, "single", 10, 1080, 0)]);
  assert.deepEqual(out, [], "720p season pack is not removed for a 1080p single");

  out = pickDuplicateLosers("radarr", [
    { id: 1, title: "M 2160p", downloadId: "x", movieId: 5, resolution: 2160, customFormatScore: 0, sizeleft: 0 },
    { id: 2, title: "M 1080p", downloadId: "y", movieId: 5, resolution: 1080, customFormatScore: 900, sizeleft: 0 },
  ]);
  assert.equal(out[0].loser.id, 2);
  assert.deepEqual(pickDuplicateLosers("lidarr", [rec(1, "a", 1, 0, 0), rec(2, "b", 1, 0, 0)]), []);
});

test("pickDuplicateLosers keeps a healthy 720p over a stalled 1080p (Graham Norton case)", () => {
  const out = pickDuplicateLosers("sonarr", [
    { id: 1, title: "GN 1080p", downloadId: "a", episodeId: 7, resolution: 1080, customFormatScore: 119, sizeleft: 9, trouble: true },
    { id: 2, title: "GN 720p", downloadId: "b", episodeId: 7, resolution: 720, customFormatScore: 103, sizeleft: 5 },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].loser.id, 1);
  assert.equal(out[0].winner.id, 2);
});

test("classifyStalled waits the configured time and respects the toggle", () => {
  const settings = { stalledMetadataMinutes: 60, stalledNoConnectionsHours: 6 };
  const meta = { errorMessage: "qBittorrent is downloading metadata" };
  const dead = { errorMessage: "The download is stalled with no connections" };
  assert.equal(classifyStalled(meta, settings, 30 * 60_000), null);
  assert.equal(classifyStalled(meta, settings, 61 * 60_000)?.blocklist, true);
  assert.equal(classifyStalled(dead, settings, 5 * 3_600_000), null);
  assert.equal(classifyStalled(dead, settings, 6 * 3_600_000)?.rule, "stalled");
  assert.equal(classifyStalled(dead, { ...settings, autoFixStalled: false }, 9 * 3_600_000), null);
  assert.equal(classifyStalled({ errorMessage: "Downloading" }, settings, 99 * 3_600_000), null);
});

test("runQueueAutoFix removes a magnet only after it has been stuck past the wait", async () => {
  const removed = [];
  const remove = async (b) => {
    removed.push(b);
    return { keptSeeding: false };
  };
  const queues = {
    radarr: {
      ok: true,
      records: [],
      issues: [{ id: 42, title: "hash123", errorMessage: "qBittorrent is downloading metadata", downloadId: "H" }],
    },
  };
  const settings = { stalledMetadataMinutes: 60, autoFixManualImport: false };
  const t0 = 1_000_000_000;
  let res = await runQueueAutoFix(queues, settings, { remove, now: t0 });
  assert.equal(res.length, 0);
  res = await runQueueAutoFix(queues, settings, { remove, now: t0 + 61 * 60_000 });
  assert.equal(res.length, 1);
  assert.equal(res[0].rule, "stalled");
  assert.equal(removed[0].blocklist, true);
});

test("fileMatchesMovie requires title and year", () => {
  const movie = { title: "Dune: Part Two", year: 2024 };
  assert.equal(fileMatchesMovie("Dune.Part.Two.2024.2160p.mkv", movie), true);
  assert.equal(fileMatchesMovie("Dune.Part.Two.2021.mkv", movie), false);
  assert.equal(fileMatchesMovie("Dune.2024.mkv", movie), false);
});

test("needsManualImport spots the manual-import queue states", () => {
  assert.equal(
    needsManualImport({ errorMessage: "Found matching series via grab history, but release was matched to series by ID. Automatic import is not possible." }),
    true,
  );
  assert.equal(needsManualImport({ trackedDownloadState: "importPending", errorMessage: "One or more episodes expected" }), true);
  assert.equal(needsManualImport({ trackedDownloadState: "importPending" }), false, "no message = app imports on its own");
  assert.equal(needsManualImport({ errorMessage: "Downloading" }), false);
});

test("planAutoImport only accepts files that match the grab exactly", () => {
  const good = {
    path: "D:\\dl\\Show.S01E01.mkv",
    series: { id: 5, title: "Show" },
    episodes: [{ id: 11, seasonNumber: 1, episodeNumber: 1 }],
    quality: { quality: { id: 3 } },
    rejections: [],
    downloadId: "abc",
  };
  const sample = { ...good, path: "D:\\dl\\sample.mkv", rejections: [{ reason: "Sample" }] };
  const expected = { seriesId: 5, episodeIds: new Set([11]) };
  const plan = planAutoImport("sonarr", [good, sample], expected);
  assert.equal(plan.files.length, 1);
  assert.deepEqual(plan.files[0].episodeIds, [11]);

  assert.ok(planAutoImport("sonarr", [{ ...good, series: { id: 6, title: "Show" } }], expected).reason);
  assert.ok(planAutoImport("sonarr", [{ ...good, episodes: [{ id: 12, seasonNumber: 1, episodeNumber: 2 }] }], expected).reason);
  assert.ok(planAutoImport("sonarr", [{ ...good, rejections: [{ reason: "Not an upgrade" }] }], expected).reason);
  assert.ok(planAutoImport("sonarr", [{ ...good, path: "D:\\dl\\x1y2z3.mkv" }], expected).reason);
  assert.ok(planAutoImport("sonarr", [sample], expected).reason);

  const movie = { path: "M.2020.mkv", movie: { id: 9, title: "M", year: 2020 }, quality: {}, rejections: [] };
  assert.equal(planAutoImport("radarr", [movie], { movieId: 9, episodeIds: new Set() }).files.length, 1);
  assert.ok(planAutoImport("radarr", [movie], { movieId: 8, episodeIds: new Set() }).reason);
});

test("runQueueAutoFix imports a season pack once and skips unsafe ones quietly", async () => {
  const calls = [];
  const importer = async (app, group) => {
    calls.push({ app, ...group, episodeIds: [...group.episodeIds].sort() });
    return group.downloadId === "ok" ? { imported: 2 } : { skipped: "file name does not match" };
  };
  const msg = "Found matching series via grab history, but release was matched to series by ID. Automatic import is not possible.";
  const queues = {
    sonarr: {
      ok: true,
      issues: [
        { id: 1, title: "Pack", downloadId: "ok", seriesId: 5, episodeId: 11, errorMessage: msg },
        { id: 2, title: "Pack", downloadId: "ok", seriesId: 5, episodeId: 12, errorMessage: msg },
        { id: 3, title: "Odd", downloadId: "bad", seriesId: 5, episodeId: 13, errorMessage: msg },
      ],
    },
    lidarr: { ok: true, issues: [{ id: 4, downloadId: "x", errorMessage: msg }] },
  };
  const settings = { autoFixEnabled: true, autoFixMaxPerScan: 10 };
  const out = await runQueueAutoFix(queues, settings, { importer, remove: async () => ({}), now: 5_000 });
  assert.deepEqual(calls.map((c) => c.downloadId), ["ok", "bad"]);
  assert.deepEqual(calls[0].episodeIds, [11, 12]);
  assert.equal(out.length, 1, "skips are not reported");
  assert.deepEqual(out[0].keys, ["queue:sonarr:1", "queue:sonarr:2"]);
  assert.equal(out[0].imported, true);

  calls.length = 0;
  await runQueueAutoFix(queues, { ...settings, autoFixManualImport: false }, { importer, remove: async () => ({}), now: 5_000 });
  assert.equal(calls.length, 0);
});
