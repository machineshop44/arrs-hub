/**
 * electron-builder (dir + portable) then Inno installer for hub or companion.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyElectronBuilderSigningEnv } from "./signing-env.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const product = process.argv[2];
if (product !== "hub" && product !== "companion") {
  console.error("Usage: node scripts/dist-win-pack.mjs hub|companion");
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const useShell =
    process.platform === "win32" && (cmd === "npm" || cmd === "npx");
  const result = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    shell: useShell,
    ...opts,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

applyElectronBuilderSigningEnv();

if (product === "companion") {
  run("node", ["scripts/audit-companion-packaging.mjs"]);
}

run("npm", ["run", "predist"]);

if (product === "hub") {
  run("npm", ["run", "build"]);
  run("npx", ["electron-builder", "--win"]);
} else {
  run("npx", [
    "electron-builder",
    "--win",
    "--config",
    "electron-builder-companion.json",
  ]);
}

run("node", ["scripts/build-inno-installers.mjs", product]);
