import test from "node:test";
import assert from "node:assert/strict";
import {
  planArrUpdate,
  planTautulliUpdate,
  supportedAppUpdateIds,
} from "./app-update.mjs";

test("supportedAppUpdateIds includes *arrs, Tautulli, qBit, and SAB", () => {
  const ids = supportedAppUpdateIds();
  for (const id of ["sonarr", "radarr", "lidarr", "prowlarr", "tautulli", "qbittorrent", "sabnzbd"]) {
    assert.ok(ids.includes(id), id);
  }
  assert.equal(ids.includes("bazarr"), false);
});

test("planArrUpdate blocks Docker/External and requires an installable row", () => {
  assert.match(planArrUpdate({ updateMechanism: "Docker" }, []).message, /docker/i);
  assert.match(planArrUpdate({ updateMechanism: "External" }, []).message, /external/i);

  const already = planArrUpdate({ updateMechanism: "BuiltIn" }, [
    { version: "4.0.1", latest: true, installed: true, installable: false },
  ]);
  assert.equal(already.alreadyCurrent, true);
  assert.equal(already.version, "4.0.1");

  const ready = planArrUpdate({ updateMechanism: "BuiltIn" }, [
    { version: "4.0.0", installed: true, installable: false },
    { version: "4.0.2", latest: true, installed: false, installable: true },
  ]);
  assert.equal(ready.ok, true);
  assert.equal(ready.version, "4.0.2");

  assert.equal(planArrUpdate({ updateMechanism: "BuiltIn" }, []).ok, false);
});

test("planTautulliUpdate trusts update_check flags", () => {
  assert.equal(
    planTautulliUpdate({ response: { result: "success", update: false } }).alreadyCurrent,
    true,
  );
  const ready = planTautulliUpdate({
    response: { result: "success", update: true, latest_release: "v2.15.0" },
  });
  assert.equal(ready.ok, true);
  assert.equal(ready.alreadyCurrent, false);
  assert.equal(ready.latest, "2.15.0");
  assert.equal(
    planTautulliUpdate({ response: { result: "error", message: "git missing" } }).ok,
    false,
  );
});
