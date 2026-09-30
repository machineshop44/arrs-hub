import test from "node:test";
import assert from "node:assert/strict";
import {
  buildProblemList,
  classifyQbInterface,
  mergeDiskSpace,
  parseDiskDrives,
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
