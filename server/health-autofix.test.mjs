import test from "node:test";
import assert from "node:assert/strict";
import { runHealthAutoFix } from "./health-autofix.mjs";
import { classifyQueueIssue } from "./queue-autofix.mjs";

const settings = { autoFixEnabled: true, keepSeedingIndexers: "TorrentDay, TorrentLeech" };
const HOUR = 3_600_000;

function fakeApi(responses) {
  const calls = [];
  const api = async (app, method, path, body) => {
    calls.push(`${app} ${method} ${path}${body?.name ? ` ${body.name}` : ""}`);
    const r = responses[`${app} ${method} ${path}`];
    if (r instanceof Error) throw r;
    return r ?? null;
  };
  return { api, calls };
}

test("queue removal rules never fire on path, disk or client-connectivity problems", () => {
  const on = { autoFixFailed: true, autoFixSample: true };
  assert.equal(classifyQueueIssue({ status: "failed", errorMessage: "Connection refused (qbittorrent)" }, on), null);
  assert.equal(classifyQueueIssue({ status: "downloadClientUnavailable" }, on), null);
  assert.equal(
    classifyQueueIssue({ errorMessage: "No files found are eligible for import. Remote path mapping: D:\\dl does not appear to exist" }, on),
    null,
  );
  assert.equal(classifyQueueIssue({ trackedDownloadState: "failed", errorMessage: "Not enough free space" }, on), null);
  assert.equal(classifyQueueIssue({ trackedDownloadState: "failed" }, on).rule, "failed");
});

test("health fixes: nudge imports, retest clients, test public indexers, skip private in backoff, cancel hung refresh", async () => {
  const now = 100 * HOUR;
  const { api, calls } = fakeApi({
    "sonarr GET /indexerstatus": [
      { indexerId: 1, disabledTill: new Date(now + HOUR).toISOString() },
      { indexerId: 2, disabledTill: new Date(now + HOUR).toISOString() },
      { indexerId: 3, disabledTill: null },
    ],
    "sonarr GET /indexer": [
      { id: 1, name: "1337x (Prowlarr)", enable: true },
      { id: 2, name: "TorrentLeech (Prowlarr)", enable: true },
      { id: 3, name: "Off on purpose", enable: false },
    ],
    "sonarr POST /indexer/test": {},
    "radarr GET /command": [
      { id: 7, name: "RefreshMovie", status: "started", started: new Date(now - 4 * HOUR).toISOString() },
      { id: 8, name: "Backup", status: "started", started: new Date(now - 9 * HOUR).toISOString() },
    ],
  });
  const snapshot = {
    health: [
      {
        id: "sonarr",
        items: [
          { source: "IndexerStatusCheck", message: "Indexers unavailable due to failures: 1337x, TorrentLeech" },
          { source: "DownloadClientStatusCheck", message: "Download clients unavailable due to failures: qBittorrent" },
        ],
      },
    ],
    queues: {
      sonarr: { ok: true, issues: [{ id: 1, trackedDownloadState: "importPending", errorMessage: "" }] },
      radarr: { ok: true, issues: [] },
    },
  };
  const out = await runHealthAutoFix(snapshot, settings, { api, now });
  assert.ok(calls.includes("sonarr POST /command ProcessMonitoredDownloads"));
  assert.ok(calls.includes("sonarr POST /downloadclient/testall"));
  assert.deepEqual(
    calls.filter((c) => c.startsWith("sonarr POST /indexer/test")),
    ["sonarr POST /indexer/test 1337x (Prowlarr)"],
    "public only; private waits; disabled skipped",
  );
  assert.ok(calls.includes("radarr DELETE /command/7"));
  assert.ok(!calls.includes("radarr DELETE /command/8"), "never cancel Backup");
  const loud = out.filter((r) => !r.quiet).map((r) => r.rule).sort();
  assert.deepEqual(loud, ["cancelHung", "testIndexer"]);

  calls.length = 0;
  await runHealthAutoFix(snapshot, settings, { api, now: now + 60_000 });
  assert.ok(!calls.some((c) => c.includes("POST")), "rate limits hold on the next scan");

  assert.deepEqual(await runHealthAutoFix(snapshot, { ...settings, autoFixHealth: false }, { api, now }), []);
});
