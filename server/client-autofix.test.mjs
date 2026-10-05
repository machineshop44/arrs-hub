import test from "node:test";
import assert from "node:assert/strict";
import { parseSeedRules, pickQbRemovals, planSabResume } from "./client-autofix.mjs";

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
