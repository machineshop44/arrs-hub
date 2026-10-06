import test from "node:test";
import assert from "node:assert/strict";
import {
  buildProblemList,
  classifyQbInterface,
  mergeDiskSpace,
  parseDiskDrives,
  parseFailingIndexers,
} from "./problems.mjs";
import { diffProblems, pruneDismissed } from "./problems-monitor.mjs";

const GIB = 1024 ** 3;
const settings = { diskFreeWarnGb: 50, diskMinTotalGb: 20, qbRequireInterfaceBind: true };

test("mergeDiskSpace dedupes paths across apps and flags low drives", () => {
  const { drives, low } = mergeDiskSpace(
    [
      { id: "sonarr", drives: [{ path: "P:\\", label: "Pool", freeSpace: 10 * GIB, totalSpace: 8000 * GIB }] },
      {
        id: "radarr",
        drives: [
          { path: "p:", label: "Pool", freeSpace: 10 * GIB, totalSpace: 8000 * GIB },
          { path: "C:\\", label: "", freeSpace: 200 * GIB, totalSpace: 500 * GIB },
          { path: "D:\\", label: "Recovery", freeSpace: 0.1 * GIB, totalSpace: 1 * GIB },
        ],
      },
    ],
    settings,
  );
  assert.equal(drives.length, 2);
  assert.equal(low.length, 1);
  assert.equal(low[0].seenBy, "sonarr");
  assert.equal(low[0].freeGb, 10);
});

test("mergeDiskSpace keeps only watched letters and collapses paths per drive", () => {
  const { drives, low } = mergeDiskSpace(
    [
      {
        id: "sonarr",
        drives: [
          { path: "D:\\Media\\TV", label: "", freeSpace: 900 * GIB, totalSpace: 20000 * GIB },
          { path: "E:\\", label: "Pool disk 1", freeSpace: 5 * GIB, totalSpace: 4000 * GIB },
          { path: "\\\\nas\\share", label: "", freeSpace: 1 * GIB, totalSpace: 100 * GIB },
        ],
      },
      {
        id: "radarr",
        drives: [
          { path: "D:\\", label: "DrivePool", freeSpace: 900 * GIB, totalSpace: 20000 * GIB },
          { path: "c:\\", label: "", freeSpace: 30 * GIB, totalSpace: 500 * GIB },
        ],
      },
    ],
    { ...settings, diskDrives: "C:, D" },
  );
  assert.deepEqual(drives.map((d) => d.path), ["c:\\", "D:\\"]);
  assert.equal(drives[1].seenBy, "sonarr");
  assert.equal(low.length, 1);
  assert.equal(low[0].path, "c:\\");
  assert.deepEqual(parseDiskDrives(" c:\\ ,d;e "), ["C:", "D:", "E:"]);
  assert.deepEqual(parseDiskDrives(""), []);
});

test("classifyQbInterface flags unbound and non-VPN adapters", () => {
  assert.equal(classifyQbInterface({}).bound, false);
  const eth = classifyQbInterface({ current_network_interface: "Ethernet", current_interface_name: "Ethernet" });
  assert.equal(eth.bound, true);
  assert.equal(eth.vpnLike, false);
  const vpn = classifyQbInterface({ current_network_interface: "{abc}", current_interface_name: "Surfshark WireGuard" });
  assert.equal(vpn.vpnLike, true);
});

test("buildProblemList produces stable keys and marks failed sources", () => {
  const { problems, failedSources } = buildProblemList({
    health: [
      { id: "sonarr", ok: true, configured: true, items: [{ type: "error", source: "IndexerStatusCheck", message: "All indexers unavailable" }] },
      { id: "radarr", ok: false, configured: true, items: [] },
    ],
    disk: { low: [] },
    qb: { ok: true, configured: true, bound: false, vpnLike: false, message: "not bound" },
    queues: { lidarr: { ok: true, configured: true, issues: [{ id: 7, title: "Album" }] } },
    ombi: { ok: true, configured: true, items: [{ id: 3, type: "tv", title: "Show", requester: "Kim" }] },
    settings,
  });
  const keys = problems.map((p) => p.key).sort();
  assert.deepEqual(keys, [
    "health:sonarr:IndexerStatusCheck",
    "ombi:tv:3",
    "queue:lidarr:7",
    "vpn:qbittorrent",
  ]);
  assert.equal(problems.find((p) => p.kind === "health").title, "Sonarr: Indexer Status");
  assert.deepEqual(failedSources, ["health:radarr"]);
});

test("diffProblems alerts once and resolves only after repeated misses", () => {
  const p = { key: "health:sonarr:X", kind: "health", severity: "warning", title: "t", detail: "d" };
  let r = diffProblems({ active: {} }, [p], []);
  assert.equal(r.added.length, 1);
  r = diffProblems(r.state, [p], []);
  assert.equal(r.added.length, 0);
  r = diffProblems(r.state, [], ["health:sonarr"]);
  assert.equal(r.resolved.length, 0, "failed source never resolves");
  r = diffProblems(r.state, [], []);
  assert.equal(r.resolved.length, 0);
  r = diffProblems(r.state, [], []);
  assert.equal(r.resolved.length, 1);
  assert.deepEqual(r.state.active, {});
});

test("diffProblems does not re-announce a flapping problem inside the cooldown", () => {
  const p = { key: "health:sonarr:DownloadClientCheck", kind: "health", severity: "warning", title: "t", detail: "d" };
  const at = (h) => new Date(Date.UTC(2026, 0, 1) + h * 3_600_000).toISOString();
  let r = diffProblems({ active: {} }, [p], [], at(0), 6);
  assert.equal(r.added.length, 1);
  r = diffProblems(r.state, [], [], at(1), 6);
  r = diffProblems(r.state, [], [], at(1.1), 6);
  assert.equal(r.resolved.length, 1);
  r = diffProblems(r.state, [p], [], at(2), 6);
  assert.equal(r.added.length, 0, "back within 6h → quiet");
  assert.ok(r.state.active[p.key], "still tracked as active");
  r = diffProblems(r.state, [], [], at(3), 6);
  r = diffProblems(r.state, [], [], at(3.1), 6);
  r = diffProblems(r.state, [p], [], at(7), 6);
  assert.equal(r.added.length, 1, "after 6h it is announced again");
});

test("diffProblems: failing indexers re-announce daily, stuck queue items only after they linger", () => {
  const at = (m) => new Date(Date.UTC(2026, 0, 1) + m * 60_000).toISOString();
  const idx = { key: "health:indexer:torrentdownloads", kind: "health", severity: "warning", title: "t", detail: "d" };
  let r = diffProblems({ active: {} }, [idx], [], at(0), 6);
  assert.equal(r.added.length, 1);
  r = diffProblems(r.state, [], [], at(60), 6);
  r = diffProblems(r.state, [], [], at(61), 6);
  r = diffProblems(r.state, [idx], [], at(7 * 60), 6);
  assert.equal(r.added.length, 0, "back after 7h → still quiet (daily for indexers)");

  const q = { key: "queue:sonarr:1", kind: "queue", severity: "warning", title: "q", detail: "importPending", announceAfterMinutes: 60 };
  r = diffProblems({ active: {} }, [q], [], at(0), 6);
  assert.equal(r.added.length, 0);
  r = diffProblems(r.state, [q], [], at(30), 6);
  assert.equal(r.added.length, 0);
  r = diffProblems(r.state, [q], [], at(61), 6);
  assert.equal(r.added.length, 1, "announced once it lingered an hour");
  r = diffProblems(r.state, [q], [], at(90), 6);
  assert.equal(r.added.length, 0);

  const brief = { ...q, key: "queue:sonarr:2" };
  r = diffProblems({ active: {} }, [brief], [], at(0), 6);
  r = diffProblems(r.state, [], [], at(5), 6);
  r = diffProblems(r.state, [], [], at(10), 6);
  assert.equal(r.added.length + r.resolved.length, 0, "cleared on its own → never mentioned");
});

test("indexer health items group into one problem per tracker across apps", () => {
  assert.deepEqual(parseFailingIndexers("Indexers unavailable due to failures: EZTV, LimeTorrents (Prowlarr)"), [
    "EZTV",
    "LimeTorrents",
  ]);
  const msg = (names) => ({ type: "warning", source: "IndexerStatusCheck", message: `Indexers unavailable due to failures: ${names}` });
  const { problems } = buildProblemList({
    health: [
      { id: "sonarr", ok: true, configured: true, items: [msg("EZTV (Prowlarr), YTS (Prowlarr)")] },
      { id: "radarr", ok: true, configured: true, items: [msg("YTS (Prowlarr)")] },
      { id: "prowlarr", ok: true, configured: true, items: [{ ...msg("EZTV"), source: "IndexerStatusCheck" }] },
    ],
    disk: { low: [] },
    qb: { ok: true, configured: false },
    queues: {},
    ombi: { ok: true, configured: false, items: [] },
    settings,
  });
  const idx = problems.filter((p) => p.key.startsWith("health:indexer:"));
  assert.equal(idx.length, 2);
  assert.ok(idx.find((p) => p.title === "Indexer failing: EZTV"));
});

test("pruneDismissed keeps cleared problems hidden until they resolve", () => {
  const p = { key: "disk:c:" };
  let d = { "disk:c:": { at: "x", misses: 0 }, "queue:sonarr:1": { at: "x", misses: 0 } };
  d = pruneDismissed(d, [p], [], ["health", "disk", "vpn"]);
  assert.ok(d["disk:c:"], "still present → stays dismissed");
  assert.ok(d["queue:sonarr:1"], "kind not scanned → untouched");
  d = pruneDismissed(d, [], ["disk"]);
  assert.ok(d["disk:c:"], "failed source never ages out");
  d = pruneDismissed(d, [], []);
  assert.ok(d["disk:c:"]);
  d = pruneDismissed(d, [], []);
  assert.deepEqual(d, {}, "gone twice → forgotten so a recurrence shows again");
});
