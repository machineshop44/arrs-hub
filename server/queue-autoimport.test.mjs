import test from "node:test";
import assert from "node:assert/strict";
import {
  fileMatchesMovie,
  fileMatchesSeries,
  needsManualImport,
  normTitle,
  planAutoImport,
} from "./queue-autoimport.mjs";
import { runQueueAutoFix } from "./queue-autofix.mjs";

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
  assert.equal(needsManualImport({ trackedDownloadState: "importPending" }), true);
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
