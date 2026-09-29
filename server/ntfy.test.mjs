import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  diffOmbiPending,
  diffQueueIssues,
  queueIssueState,
  stepServiceTransition,
} from "./ntfy.mjs";

describe("diffOmbiPending", () => {
  const items = [
    { id: 1, type: "movie", title: "A" },
    { id: 7, type: "tv", title: "B" },
  ];

  it("records but does not alert on the first run", () => {
    const out = diffOmbiPending([], items, false);
    assert.deepEqual(out.fresh, []);
    assert.deepEqual(out.seen.sort(), ["movie:1", "tv:7"]);
  });

  it("alerts only for ids not seen before", () => {
    const out = diffOmbiPending(
      ["movie:1"],
      [...items, { id: 1, type: "tv", title: "C" }],
      true,
    );
    assert.deepEqual(
      out.fresh.map((i) => `${i.type}:${i.id}`),
      ["tv:7", "tv:1"],
    );
  });
});

describe("diffQueueIssues", () => {
  const queues = {
    sonarr: { ok: true, issues: [{ id: 10 }, { id: 11 }] },
    radarr: { ok: false, issues: [] },
  };

  it("primes each app on its first successful read", () => {
    const out = diffQueueIssues([], queues, []);
    assert.deepEqual(out.fresh, []);
    assert.deepEqual(out.primedApps, ["sonarr"]);
  });

  it("alerts new issues, dedupes by app+id, keeps keys for unreadable apps", () => {
    const out = diffQueueIssues(
      ["sonarr:10", "radarr:5", "sonarr:99"],
      queues,
      ["sonarr", "radarr"],
    );
    assert.deepEqual(
      out.fresh.map((f) => `${f.app}:${f.issue.id}`),
      ["sonarr:11"],
    );
    assert.ok(out.seen.includes("radarr:5"));
    assert.ok(!out.seen.includes("sonarr:99"));
  });
});

describe("queueIssueState", () => {
  it("labels tracked states", () => {
    assert.equal(queueIssueState({ trackedDownloadState: "importPending" }), "import pending");
    assert.equal(queueIssueState({ trackedDownloadState: "failedPending" }), "failed");
    assert.equal(queueIssueState({ trackedDownloadStatus: "warning" }), "warning");
    assert.equal(queueIssueState({ trackedDownloadStatus: "error" }), "error");
  });
});

describe("stepServiceTransition", () => {
  const opts = { debounceMs: 60_000, cooldownMs: 600_000 };

  it("sets a baseline without alerting", () => {
    const r = stepServiceTransition(undefined, true, 0, opts);
    assert.equal(r.alert, null);
    assert.equal(r.track.baseline, true);
  });

  it("alerts down only after the debounce window", () => {
    let r = stepServiceTransition(undefined, true, 0, opts);
    r = stepServiceTransition(r.track, false, 1_000, opts);
    assert.equal(r.alert, null);
    r = stepServiceTransition(r.track, false, 61_000, opts);
    assert.equal(r.alert, "down");
  });

  it("ignores flapping inside the debounce window", () => {
    let r = stepServiceTransition(undefined, true, 0, opts);
    r = stepServiceTransition(r.track, false, 1_000, opts);
    r = stepServiceTransition(r.track, true, 30_000, opts);
    r = stepServiceTransition(r.track, false, 70_000, opts);
    assert.equal(r.alert, null);
  });

  it("ignores unknown (null) states", () => {
    let r = stepServiceTransition(undefined, true, 0, opts);
    r = stepServiceTransition(r.track, null, 100_000, opts);
    assert.equal(r.alert, null);
    assert.equal(r.track.baseline, true);
  });

  it("sends up after down, then suppresses a repeat down/up inside the cooldown", () => {
    let r = stepServiceTransition(undefined, true, 0, opts);
    r = stepServiceTransition(r.track, false, 1_000, opts);
    r = stepServiceTransition(r.track, false, 62_000, opts);
    assert.equal(r.alert, "down");
    r = stepServiceTransition(r.track, true, 100_000, opts);
    r = stepServiceTransition(r.track, true, 170_000, opts);
    assert.equal(r.alert, "up");
    r = stepServiceTransition(r.track, false, 200_000, opts);
    r = stepServiceTransition(r.track, false, 270_000, opts);
    assert.equal(r.alert, null);
    r = stepServiceTransition(r.track, true, 300_000, opts);
    r = stepServiceTransition(r.track, true, 370_000, opts);
    assert.equal(r.alert, null);
    assert.equal(r.track.baseline, true);
  });

  it("reports recovery for a service already down at startup", () => {
    let r = stepServiceTransition(undefined, false, 0, opts);
    r = stepServiceTransition(r.track, true, 1_000, opts);
    r = stepServiceTransition(r.track, true, 62_000, opts);
    assert.equal(r.alert, "up");
  });
});
