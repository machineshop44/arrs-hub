/**
 * Build the Hub, build Companion only when its own version isn't published yet,
 * then publish to Drive. Companion code changes without a version bump stop the build.
 *
 * FORCE_COMPANION=1 rebuilds Companion even if that version is already on Drive.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { companionStatus, root } from "./companion-version.mjs";

const driveDir = process.env.ARRS_DRIVE_EXE_DIR || "G:\\My Drive\\exe";

function run(script) {
  const r = spawnSync("npm", ["run", script], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const companion = companionStatus();
if (companion.changed) {
  console.error(
    `[dist] Companion files changed since v${companion.version} was recorded. Run "npm run companion:bump" so the downloader PC gets a new version.`,
  );
  process.exit(1);
}

const published = fs.existsSync(path.join(driveDir, `Arrs Hub Companion-${companion.version}-x64.exe`));
const buildCompanion = process.env.FORCE_COMPANION === "1" || !published;

run("dist:win");
if (buildCompanion) {
  console.log(`[dist] Building Companion v${companion.version}`);
  run("dist:win:companion");
} else {
  console.log(`[dist] Companion v${companion.version} unchanged and already published — skipping.`);
}
run("publish:exe");
