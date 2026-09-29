import test from "node:test";
import assert from "node:assert/strict";
import {
  buildProblemList,
  classifyQbInterface,
  mergeDiskSpace,
} from "./problems.mjs";
import { diffProblems } from "./problems-monitor.mjs";

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
