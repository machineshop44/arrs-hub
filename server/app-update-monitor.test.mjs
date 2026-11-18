import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  collectAutoAppUpdateCandidates,
  runAutoAppUpdatePass,
} from "./app-update-monitor.mjs";
import { supportedAppUpdateIds } from "./app-update.mjs";
import { defaultMonitorSettings } from "./monitor-settings.mjs";

describe("collectAutoAppUpdateCandidates", () => {
  it("picks yellow supported apps from hub + companion chips", () => {
    const candidates = collectAutoAppUpdateCandidates({
      arrs: [
        {
          id: "sonarr",
          label: "Sonarr",
          updateAvailable: true,
          latestVersion: "4.0.10",
        },
        {
          id: "bazarr",
          label: "Bazarr",
          updateAvailable: true,
          latestVersion: "1.4.0",
        },
        {
          id: "radarr",
          label: "Radarr",
          updateAvailable: false,
          latestVersion: null,
        },
        {
          id: "tautulli",
          label: "Tautulli",
          updateAvailable: true,
          latestVersion: "2.15.0",
        },
      ],
      companion: {
        pcId: "pc-dl",
        apps: [
          {
            id: "qbittorrent",
            label: "qBittorrent",
            updateAvailable: true,
            latestVersion: "5.1.0",
          },
          {
            id: "sabnzbd",
            label: "SABnzbd",
            updateAvailable: false,
            latestVersion: null,
          },
        ],
      },
    });

    assert.deepEqual(
      candidates.map((c) => c.id),
      ["sonarr", "tautulli", "qbittorrent"],
    );
    assert.equal(candidates[0].targetVersion, "4.0.10");
    assert.equal(candidates[2].pcId, "pc-dl");
    assert.ok(!candidates.some((c) => c.id === "bazarr"));
  });

  it("dedupes and respects supportedAppUpdateIds", () => {
    const ids = supportedAppUpdateIds();
    assert.ok(ids.includes("sonarr"));
    const candidates = collectAutoAppUpdateCandidates(
      {
        arrs: [
          { id: "sonarr", label: "Sonarr", updateAvailable: true, latestVersion: "1" },
          { id: "sonarr", label: "Sonarr", updateAvailable: true, latestVersion: "2" },
        ],
        companion: {
          pcId: "x",
          apps: [
            {
              id: "sonarr",
              label: "Sonarr",
              updateAvailable: true,
              latestVersion: "3",
            },
          ],
        },
      },
      ids,
    );
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].targetVersion, "1");
  });
});

describe("runAutoAppUpdatePass", () => {
  it("skips when disabled", async () => {
    const result = await runAutoAppUpdatePass({
      settings: { ...defaultMonitorSettings(), autoAppUpdateEnabled: false },
      versions: {
        arrs: [
          {
            id: "sonarr",
            label: "Sonarr",
            updateAvailable: true,
            latestVersion: "9.9.9",
          },
        ],
      },
      startUpdate: () => {
        throw new Error("should not start");
      },
      silentNotify: true,
    });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "disabled");
  });

  it("starts updates for yellow apps and caps at 3", async () => {
    const started = [];
    const result = await runAutoAppUpdatePass({
      settings: { ...defaultMonitorSettings(), autoAppUpdateEnabled: true },
      versions: {
        arrs: [
          { id: "sonarr", label: "Sonarr", updateAvailable: true, latestVersion: "1" },
          { id: "radarr", label: "Radarr", updateAvailable: true, latestVersion: "2" },
          { id: "lidarr", label: "Lidarr", updateAvailable: true, latestVersion: "3" },
          { id: "prowlarr", label: "Prowlarr", updateAvailable: true, latestVersion: "4" },
        ],
        companion: null,
      },
      startUpdate: (body) => {
        started.push(body.id);
      },
      waitForJob: async (id) => ({
        phase: "done",
        message: `${id} ok`,
        error: null,
      }),
      silentNotify: true,
    });
    assert.equal(result.skipped, false);
    assert.deepEqual(started, ["sonarr", "radarr", "lidarr"]);
    assert.equal(result.results.length, 3);
    assert.ok(result.results.every((r) => r.ok));
  });
});

describe("monitor settings auto app update defaults", () => {
  it("defaults autoAppUpdate on with 6h interval", () => {
    const d = defaultMonitorSettings();
    assert.equal(d.autoAppUpdateEnabled, true);
    assert.equal(d.autoAppUpdateIntervalHours, 6);
  });
});
