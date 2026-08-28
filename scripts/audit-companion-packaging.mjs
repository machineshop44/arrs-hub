/**
 * Pre-build sanity check for Arrs Hub Companion packaging.
 * Catches missing modules/constants before shipping an installer.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const requiredCompanionFiles = [
  "desktop-companion/main.cjs",
  "desktop-companion/win-login-item.cjs",
  "desktop-companion/icon.ico",
  "desktop-companion/icon.png",
  "companion/server.mjs",
  "companion/companion-store.mjs",
  "companion/hub-client.mjs",
  "companion/network.mjs",
  "server/restart-windows.mjs",
  "server/wol.mjs",
  "server/lan-utils.mjs",
  "package.json",
  "build/icon.ico",
];

const mainMustDefine = [
  "LOGIN_SETTINGS_FILE",
  "APP_DISPLAY_NAME",
  "DEFAULT_PORT",
  "syncOpenAtLogin",
  "toggleOpenAtLogin",
  "refreshTrayMenu",
  "createTray",
  "boot",
];

const mainMustRequire = ["./win-login-item.cjs"];

function fail(message) {
  console.error(`[audit-companion] FAIL: ${message}`);
  process.exit(1);
}

function ok(message) {
  console.log(`[audit-companion] OK: ${message}`);
}

for (const rel of requiredCompanionFiles) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) {
    fail(`Missing required file: ${rel}`);
  }
}
ok(`${requiredCompanionFiles.length} required files present`);

const mainPath = path.join(root, "desktop-companion/main.cjs");
const mainSource = fs.readFileSync(mainPath, "utf8");

for (const token of mainMustDefine) {
  if (!mainSource.includes(token)) {
    fail(`desktop-companion/main.cjs missing expected symbol: ${token}`);
  }
}

for (const req of mainMustRequire) {
  if (!mainSource.includes(`require("${req}")`)) {
    fail(`desktop-companion/main.cjs must require ${req}`);
  }
}

if (mainSource.includes("../desktop/win-login-item")) {
  fail("main.cjs must not require ../desktop/win-login-item (excluded from package)");
}

const winLoginPath = path.join(root, "desktop-companion/win-login-item.cjs");
const winLoginSource = fs.readFileSync(winLoginPath, "utf8");
for (const fn of ["syncOpenAtLogin", "toggleOpenAtLogin", "module.exports"]) {
  if (!winLoginSource.includes(fn)) {
    fail(`win-login-item.cjs missing ${fn}`);
  }
}
ok("main.cjs symbols and local win-login-item exports");

const builder = JSON.parse(
  fs.readFileSync(path.join(root, "electron-builder-companion.json"), "utf8"),
);
const files = builder.files || [];
if (!files.some((f) => f.startsWith("desktop-companion/"))) {
  fail("electron-builder-companion.json must include desktop-companion/**/*");
}
if (files.some((f) => f.includes("desktop/win-login") && !f.startsWith("!"))) {
  fail("Do not rely on desktop/win-login-item in companion package");
}
if (!files.some((f) => f.includes("server/lan-utils.mjs"))) {
  fail("electron-builder-companion.json must include server/lan-utils.mjs");
}
ok("electron-builder companion file patterns");

const importRe = /from\s+["']([^"']+)["']/g;
const visited = new Set();
const queue = ["companion/server.mjs"];

while (queue.length) {
  const rel = queue.shift();
  if (visited.has(rel)) continue;
  visited.add(rel);

  const full = path.join(root, rel);
  if (!fs.existsSync(full)) {
    fail(`Import chain missing: ${rel}`);
  }

  const source = fs.readFileSync(full, "utf8");
  let match;
  while ((match = importRe.exec(source))) {
    const spec = match[1];
    if (!spec.startsWith(".") && !spec.startsWith("..")) continue;
    const base = path.dirname(full);
    let resolved = path.normalize(path.join(base, spec));
    if (!resolved.endsWith(".mjs") && !resolved.endsWith(".js")) {
      for (const ext of [".mjs", ".js", "/index.mjs"]) {
        const candidate = resolved + ext;
        if (fs.existsSync(candidate)) {
          resolved = candidate;
          break;
        }
      }
    }
    const nextRel = path.relative(root, resolved).replace(/\\/g, "/");
    if (!visited.has(nextRel)) queue.push(nextRel);
  }
}
ok(`companion import chain (${visited.size} modules)`);

console.log("[audit-companion] All checks passed.");
