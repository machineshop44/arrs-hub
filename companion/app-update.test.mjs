import test from "node:test";
import assert from "node:assert/strict";
import {
  compareSemver,
  interpretWingetOutput,
  pickWindowsSetupAsset,
  qbitSourceForgeSetup,
  resolveWingetPath,
  supportedCompanionUpdateIds,
} from "./app-update.mjs";

test("supportedCompanionUpdateIds covers qBit and SAB", () => {
  assert.deepEqual(supportedCompanionUpdateIds().sort(), ["qbittorrent", "sabnzbd"]);
});

test("resolveWingetPath returns a non-empty path string", () => {
  const p = resolveWingetPath();
  assert.equal(typeof p, "string");
  assert.ok(p.length > 0);
});

test("interpretWingetOutput treats already-current as success with flag", () => {
  const a = interpretWingetOutput({
    ok: false,
    code: -1978335189,
    message: "No applicable update found.",
  });
  assert.equal(a.ok, true);
  assert.equal(a.alreadyCurrent, true);
  const b = interpretWingetOutput({
    ok: false,
    code: 1,
    message: "No newer package versions are available from the configured sources.",
  });
  assert.equal(b.ok, true);
  assert.equal(b.alreadyCurrent, true);
});

test("interpretWingetOutput asks for install or elevation when needed", () => {
  const missing = interpretWingetOutput({
    ok: false,
    code: 1,
    message: "No installed package found matching input criteria.",
  });
  assert.equal(missing.retryInstall, true);

  const admin = interpretWingetOutput({
    ok: false,
    code: -1978335215,
    message: "This operation requires administrator privileges.",
  });
  assert.equal(admin.needsElevation, true);
});

test("pickWindowsSetupAsset prefers x64 setup EXEs", () => {
  const pick = pickWindowsSetupAsset([
    { name: "SABnzbd-4.5.0-src.tar.gz", browser_download_url: "https://x/a" },
    { name: "SABnzbd-4.5.0-win-setup.exe", browser_download_url: "https://x/setup.exe" },
    { name: "SABnzbd-4.5.0-win-portable.zip", browser_download_url: "https://x/p.zip" },
  ]);
  assert.equal(pick?.name, "SABnzbd-4.5.0-win-setup.exe");
  assert.equal(pickWindowsSetupAsset([]), null);
});

test("qbitSourceForgeSetup builds the official x64 download URL", () => {
  const asset = qbitSourceForgeSetup("5.3.0");
  assert.equal(asset?.name, "qbittorrent_5.3.0_x64_setup.exe");
  assert.match(asset?.url || "", /qbittorrent-5\.3\.0\/qbittorrent_5\.3\.0_x64_setup\.exe\/download$/);
  assert.equal(qbitSourceForgeSetup(""), null);
});

test("compareSemver orders qBit-style versions", () => {
  assert.equal(compareSemver("5.2.4", "5.3.0"), -1);
  assert.equal(compareSemver("5.3.0", "5.3.0"), 0);
  assert.equal(compareSemver("5.3.1", "5.3.0"), 1);
});
