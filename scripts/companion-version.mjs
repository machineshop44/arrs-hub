/**
 * Companion has its own version (server/companion-version.json) so a Hub-only
 * release never republishes an unchanged Companion.
 *
 *   node scripts/companion-version.mjs          → status
 *   node scripts/companion-version.mjs --bump   → version = package.json version, record source hash
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(__dirname, "..");
export const COMPANION_VERSION_PATH = path.join(root, "server", "companion-version.json");

function walk(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
}

/** Everything that ends up inside the Companion build (minus package.json, whose version changes every Hub release). */
export function companionSourceFiles() {
  const config = JSON.parse(fs.readFileSync(path.join(root, "electron-builder-companion.json"), "utf8"));
  const files = [];
  walk(path.join(root, "desktop-companion"), files);
  walk(path.join(root, "companion"), files);
  for (const pattern of config.files || []) {
    if (/^server\/[^*!]+\.mjs$/.test(pattern)) files.push(path.join(root, pattern));
  }
  for (const extra of ["electron-builder-companion.json", "packaging/arrs-hub-companion.iss", "build/installer-companion.nsh"]) {
    files.push(path.join(root, extra));
  }
  return [...new Set(files)].filter((f) => fs.existsSync(f)).sort();
}

export function hashCompanionSources() {
  const hash = crypto.createHash("sha256");
  for (const file of companionSourceFiles()) {
    hash.update(path.relative(root, file).replace(/\\/g, "/"));
    hash.update("\0");
    hash.update(fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n"));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function readCompanionVersion() {
  return JSON.parse(fs.readFileSync(COMPANION_VERSION_PATH, "utf8"));
}

export function companionStatus() {
  const recorded = readCompanionVersion();
  const current = hashCompanionSources();
  return { version: recorded.version, changed: current !== recorded.sourceHash, current };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--bump")) {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const next = { version: pkg.version, sourceHash: hashCompanionSources() };
    fs.writeFileSync(COMPANION_VERSION_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    console.log(`[companion] version → ${next.version}`);
  } else {
    const s = companionStatus();
    console.log(`[companion] v${s.version} — ${s.changed ? "CHANGED since last bump (run npm run companion:bump)" : "unchanged"}`);
  }
}
