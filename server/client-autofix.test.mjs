import test from "node:test";
import assert from "node:assert/strict";
import { parseSeedRules, pickQbRemovals, pickSabRetries, planSabResume } from "./client-autofix.mjs";
import { pickNeverSearched, pickVanished, planPlexRefreshes } from "./stack-autofix.mjs";

test("pickSabRetries retries repairable failures once, never password / disk ones", () => {
  const slots = [
    { nzo_id: "a", status: "Failed", fail_message: "Aborted, cannot be completed - https://sabnzbd.org/not-complete" },
    { nzo_id: "b", status: "Failed", fail_message: "Unpacking failed, archive requires a password" },
    { nzo_id: "c", status: "Failed", fail_message: "Repair failed, not enough repair blocks (12 short)" },
    { nzo_id: "d", status: "Failed", fail_message: "Not enough disk space" },
    { nzo_id: "e", status: "Completed", fail_message: "" },
    { nzo_id: "f", status: "Failed", fail_message: "Download failed - missing articles" },
  ];
  const picks = pickSabRetries(slots, new Set(["f"]), new Set(["c"]));
  assert.deepEqual(picks.map((s) => s.nzo_id), ["a"]);
});

test("pickVanished only clears items when the client was readable and lacks the download", () => {
  const msg = { statusMessages: [{ title: "x", messages: ["Download is no longer in the download client"] }] };
  const queues = {
    sonarr: [
      { id: 1, downloadId: "AAA", protocol: "torrent", ...msg },
      { id: 2, downloadId: "BBB", protocol: "torrent", ...msg },
      { id: 3, downloadId: "SABnzbd_nzo_1", protocol: "usenet", ...msg },
      { id: 4, downloadId: "CCC", protocol: "torrent" },
    ],
  };
  assert.deepEqual(pickVanished(queues, new Set(["bbb"]), null).map((v) => v.record.id), [1]);
  assert.deepEqual(pickVanished(queues, null, new Set()).map((v) => v.record.id), [3]);
});

test("pickNeverSearched needs monitored, missing, a day old, never searched, not queued", () => {
  const now = Date.parse("2026-10-05T12:00:00Z");
  const old = "2026-10-01T00:00:00Z";
  const items = [
    { id: 1, monitored: true, hasFile: false, lastSearchTime: null, date: old },
    { id: 2, monitored: true, hasFile: false, lastSearchTime: "2026-10-02T00:00:00Z", date: old },
    { id: 3, monitored: false, hasFile: false, lastSearchTime: null, date: old },
    { id: 4, monitored: true, hasFile: false, lastSearchTime: null, date: "2026-10-05T06:00:00Z" },
    { id: 5, monitored: true, hasFile: false, date: old },
    { id: 6, monitored: true, hasFile: false, lastSearchTime: null, date: old },
    { id: 7, monitored: true, hasFile: false, lastSearchTime: null, date: old },
  ];
  assert.deepEqual(pickNeverSearched(items, new Set([6]), now, 5).map((i) => i.id), [1, 7]);
  assert.deepEqual(pickNeverSearched(items, new Set(), now, 1).map((i) => i.id), [1]);
});

test("planPlexRefreshes scans each imported folder once, skipping busy or already-scanned libraries", () => {
  const sections = [
    { id: "1", title: "TV", scannedAt: 100, refreshing: false, locations: ["N:\\TV"] },
    { id: "2", title: "Movies", scannedAt: 9_999_999_999, refreshing: false, locations: ["N:\\Movies"] },
  ];
  const plans = planPlexRefreshes(
    [
      { path: "N:\\TV\\Show\\Season 01\\Show - S01E01.mkv", date: 200_000 },
      { path: "N:\\TV\\Show\\Season 01\\Show - S01E02.mkv", date: 200_000 },
      { path: "N:\\Movies\\Film (2020)\\Film.mkv", date: 200_000 },
      { path: "D:\\Elsewhere\\x.mkv", date: 200_000 },
    ],
    sections,
  );
  assert.equal(plans.length, 1);
  assert.equal(plans[0].section.id, "1");
  assert.equal(plans[0].folder, "N:\\TV\\Show\\Season 01");
});

const DAY = 86_400;

test("parseSeedRules reads host = days lines", () => {
  assert.deepEqual(parseSeedRules("Sync.td-peers.com = 3.5\ntleechreload.org: 10d, junk"), [
    { match: "sync.td-peers.com", days: 3.5 },
    { match: "tleechreload.org", days: 10 },
  ]);
});

test("pickQbRemovals honors import, queue and per-tracker seed time", () => {
  const rules = parseSeedRules("td-peers.com = 3.5\ntleechreload.org = 3.5");
  const importedBy = new Map([
    ["a", "sonarr"],
    ["b", "radarr"],
    ["c", "sonarr"],
    ["d", "sonarr"],
    ["e", "radarr"],
  ]);
  const t = (hash, tracker, seededDays, extra = {}) => ({
    hash,
    name: hash.toUpperCase(),
    state: "stalledUP",
    progress: 1,
    seeding_time: seededDays * DAY,
    trackers: tracker ? [tracker] : [],
    ...extra,
  });
  const picks = pickQbRemovals(
    [
      t("a", "https://sync.td-peers.com/announce?pk=x", 3), // TorrentDay, too soon
      t("b", "https://tracker.tleechreload.org/a/123/announce", 4), // TorrentLeech, done
      t("c", "udp://tracker.opentrackr.org:1337/announce", 0), // public, no minimum
      t("d", "udp://tracker.opentrackr.org:1337/announce", 0), // still in an *arr queue
      t("e", "", 99), // tracker unknown → keep
      t("z", "udp://x.org/announce", 9), // never imported (manual download)
      t("a2", "udp://x.org/announce", 9, { progress: 0.5 }),
    ],
    { importedBy, activeHashes: new Set(["d"]), rules, nowSec: 0 },
  );
  assert.deepEqual(picks.map((p) => p.hash), ["b", "c"]);
  assert.match(picks[0].reason, /tleechreload\.org needs 3\.5 d/);
});

test("planSabResume resumes paused queue + items but respects timed pauses and full disks", () => {
  const slots = [
    { nzo_id: "1", status: "Paused", filename: "A" },
    { nzo_id: "2", status: "Downloading", filename: "B" },
  ];
  let p = planSabResume({ paused: true, pause_int: "0", diskspace1: "500", slots });
  assert.equal(p.resumeAll, true);
  assert.deepEqual(p.items.map((s) => s.nzo_id), ["1"]);
  p = planSabResume({ paused: true, pause_int: "29:59", slots });
  assert.equal(p.skip, "timed pause set");
  p = planSabResume({ paused: true, pause_int: "0", diskspace1: "0.4", slots });
  assert.equal(p.skip, "download disk almost full");
});
