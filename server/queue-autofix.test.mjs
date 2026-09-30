import test from "node:test";
import assert from "node:assert/strict";
import { classifyQueueIssue, runQueueAutoFix } from "./queue-autofix.mjs";
import { mustKeepSeeding } from "./queue-actions.mjs";

const on = {
  autoFixEnabled: true,
  autoFixDangerous: true,
  autoFixSample: true,
  autoFixNotUpgrade: true,
  autoFixFailed: true,
  autoFixMaxPerScan: 10,
};

test("classifyQueueIssue picks the right rule and leaves manual-import cases alone", () => {
  assert.equal(
    classifyQueueIssue({ errorMessage: "Caution: Found potentially dangerous file with extension: .exe" }, on).rule,
    "dangerous",
  );
  assert.equal(classifyQueueIssue({ errorMessage: "Show.S01E01.mkv.lnk" }, on).rule, "dangerous");
  assert.equal(classifyQueueIssue({ errorMessage: "No files found are eligible for import in C:\\dl" }, on).rule, "sample");
  assert.equal(classifyQueueIssue({ errorMessage: "Not an upgrade for existing episode file(s)" }, on).rule, "notUpgrade");
  assert.equal(classifyQueueIssue({ errorMessage: "Not an upgrade for existing episode file(s)" }, on).blocklist, false);
  assert.equal(classifyQueueIssue({ trackedDownloadState: "failedPending" }, on).rule, "failed");
  assert.equal(
    classifyQueueIssue({ errorMessage: "Found matching series via grab history, but release was matched to series by ID. Automatic import is not possible." }, on),
    null,
  );
  assert.equal(classifyQueueIssue({ errorMessage: "found .exe" }, { ...on, autoFixDangerous: false }), null);
});

test("mustKeepSeeding protects private trackers and unknown torrents", () => {
  const keep = "TorrentDay, TorrentLeech";
  assert.equal(mustKeepSeeding({ indexer: "TorrentLeech (Prowlarr)", protocol: "torrent" }, keep), true);
  assert.equal(mustKeepSeeding({ indexer: "Torrent Day", protocol: "torrent" }, keep), true);
  assert.equal(mustKeepSeeding({ indexer: "1337x (Prowlarr)", protocol: "torrent" }, keep), false);
  assert.equal(mustKeepSeeding({ indexer: "", protocol: "torrent" }, keep), true);
  assert.equal(mustKeepSeeding({ indexer: "", protocol: "usenet" }, keep), false);
  assert.equal(mustKeepSeeding({ indexer: "TorrentDay" }, ""), false);
});

test("runQueueAutoFix removes matching items, respects the cap, and retries failures later", async () => {
  const calls = [];
  const remove = async (body) => {
    calls.push(body);
    if (body.id === 3) throw new Error("boom");
    return { keptSeeding: body.indexer === "TorrentDay" };
  };
  const queues = {
    sonarr: {
      ok: true,
      issues: [
        { id: 1, title: "A", errorMessage: "dangerous file .exe", indexer: "TorrentDay", protocol: "torrent" },
        { id: 2, title: "B", errorMessage: "Manual import required" },
        { id: 3, title: "C", trackedDownloadState: "failed" },
      ],
    },
  };
  const out = await runQueueAutoFix(queues, on, { remove, now: 1_000 });
  assert.deepEqual(calls.map((c) => c.id), [1, 3]);
  assert.equal(out[0].ok, true);
  assert.equal(out[0].keptSeeding, true);
  assert.equal(out[0].blocklist, true);
  assert.equal(out[1].ok, false);

  calls.length = 0;
  await runQueueAutoFix(queues, on, { remove, now: 2_000 });
  assert.deepEqual(calls.map((c) => c.id), [1], "failed item waits before retrying");

  calls.length = 0;
  await runQueueAutoFix(queues, { ...on, autoFixMaxPerScan: 1 }, { remove, now: 10_000_000 });
  assert.equal(calls.length, 1);

  assert.deepEqual(await runQueueAutoFix(queues, { ...on, autoFixEnabled: false }, { remove }), []);
});
