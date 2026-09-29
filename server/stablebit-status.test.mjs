import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { summarizeDrivePool, summarizeScanner } from "./stablebit-status.mjs";

const TB = 1024 ** 4;

describe("summarizeDrivePool", () => {
  it("reports not installed when the service is missing", () => {
    const s = summarizeDrivePool({ service: null, pools: [] });
    assert.equal(s.installed, false);
  });

  it("flags a stopped service", () => {
    const s = summarizeDrivePool({
      service: { name: "DrivePoolService", status: "Stopped" },
      pools: [],
    });
    assert.equal(s.installed, true);
    assert.equal(s.running, false);
  });

  it("computes free % and warns under 10%", () => {
    const s = summarizeDrivePool({
      service: { name: "DrivePoolService", status: "Running" },
      pools: { letter: "P:", label: "Pool", size: 40 * TB, free: 2 * TB },
    });
    assert.equal(s.pools.length, 1);
    assert.equal(s.pools[0].freePct, 5);
    assert.equal(s.lowSpace, true);
  });
});

describe("summarizeScanner", () => {
  it("counts unhealthy disks and SMART predict-failure", () => {
    const s = summarizeScanner({
      service: { name: "Scanner", status: "Running" },
      disks: [
        { name: "WDC 12TB", size: 12 * TB, health: "Healthy" },
        { name: "ST 8TB", size: 8 * TB, health: "Warning" },
      ],
      smartFailures: 2,
    });
    assert.equal(s.running, true);
    assert.equal(s.problemCount, 2);
  });

  it("is healthy when all disks are healthy", () => {
    const s = summarizeScanner({
      service: { name: "Scanner", status: "Running" },
      disks: { name: "WDC 12TB", size: 12 * TB, health: "Healthy" },
      smartFailures: 0,
    });
    assert.equal(s.problemCount, 0);
    assert.equal(s.disks.length, 1);
  });
});
