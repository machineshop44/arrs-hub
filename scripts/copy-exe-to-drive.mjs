/**
 * Copy Arrs Hub + Companion Windows installers to Google Drive exe folder.
 * Run after dist:win:all (or manually after both builds).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const driveDir =
  process.env.ARRS_DRIVE_EXE_DIR || "G:\\My Drive\\exe";

const pkg = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const version = pkg.version;

function hubArtifact(filename) {
  const dirs = ["release", "release-133"];
  for (const dir of dirs) {
    const full = path.join(root, dir, filename);
    if (fs.existsSync(full)) return full;
  }
  return path.join(root, "release", filename);
}

function companionArtifact(filename) {
  const dirs = ["release-companion", "release-companion-132", "release-companion-133"];
  for (const dir of dirs) {
    const full = path.join(root, dir, filename);
    if (fs.existsSync(full)) return full;
  }
  return path.join(root, "release-companion", filename);
}

const artifacts = [
  {
    label: "Arrs Hub NSIS",
    src: hubArtifact(`Arrs Hub-${version}-x64.exe`),
  },
  {
    label: "Arrs Hub portable",
    src: hubArtifact(`Arrs Hub-${version}-portable.exe`),
  },
  {
    label: "Arrs Hub Companion NSIS",
    src: companionArtifact(`Arrs Hub Companion-${version}-x64.exe`),
  },
  {
    label: "Arrs Hub Companion portable",
    src: companionArtifact(`Arrs Hub Companion-${version}-portable.exe`),
  },
];

if (!fs.existsSync(driveDir)) {
  fs.mkdirSync(driveDir, { recursive: true });
  console.log(`[copy-exe] Created ${driveDir}`);
}

let copied = 0;
for (const item of artifacts) {
  if (!fs.existsSync(item.src)) {
    console.warn(`[copy-exe] SKIP ${item.label} — missing ${item.src}`);
    continue;
  }
  const dest = path.join(driveDir, path.basename(item.src));
  fs.copyFileSync(item.src, dest);
  console.log(`[copy-exe] ${item.label} → ${dest}`);
  copied += 1;
}

if (copied === 0) {
  console.error("[copy-exe] Nothing copied. Run npm run dist:win:all first.");
  process.exit(1);
}

console.log(`[copy-exe] Done (${copied} file(s) in ${driveDir}).`);
