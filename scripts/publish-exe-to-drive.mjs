/**
 * Publish Arrs Hub + Companion Windows artifacts to Google Drive\exe
 * (ytarr / Market Advisor style: SHA256 checksums, prune old builds).
 *
 * Run after: npm run dist:win:all
 * Optional signing: ARRS_SIGN_PFX_PATH + ARRS_SIGN_PFX_PASSWORD
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signWindowsArtifacts } from "./sign-windows-artifacts.mjs";
import { signingStatusLine } from "./signing-env.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const driveDir =
  process.env.ARRS_DRIVE_EXE_DIR || "G:\\My Drive\\exe";

const pkg = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const version = pkg.version;

function hubArtifact(filename) {
  const dirs = ["release", "release-133", "release-135", "release-137"];
  for (const dir of dirs) {
    const full = path.join(root, dir, filename);
    if (fs.existsSync(full)) return full;
  }
  return path.join(root, "release", filename);
}

function companionArtifact(filename) {
  const dirs = [
    "release-companion",
    "release-companion-132",
    "release-companion-133",
    "release-companion-134",
    "release-companion-136",
    "release-companion-137",
  ];
  for (const dir of dirs) {
    const full = path.join(root, dir, filename);
    if (fs.existsSync(full)) return full;
  }
  return path.join(root, "release-companion", filename);
}

const artifactGroups = [
  {
    prefix: "Arrs Hub",
    items: [
      { label: "NSIS/Inno installer", file: `Arrs Hub-${version}-x64.exe` },
      { label: "portable", file: `Arrs Hub-${version}-portable.exe` },
    ],
    resolve: hubArtifact,
  },
  {
    prefix: "Arrs Hub Companion",
    items: [
      {
        label: "NSIS/Inno installer",
        file: `Arrs Hub Companion-${version}-x64.exe`,
      },
      {
        label: "portable",
        file: `Arrs Hub Companion-${version}-portable.exe`,
      },
    ],
    resolve: companionArtifact,
  },
];

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex").toUpperCase();
}

function pruneOldOnDrive(prefix) {
  if (!fs.existsSync(driveDir)) return;
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const keepVer = version.replace(/\./g, "\\.");
  const re = new RegExp(`^${escaped}-(?!${keepVer})`);
  for (const name of fs.readdirSync(driveDir)) {
    if (!re.test(name)) continue;
    if (!/\.(exe|txt)$/i.test(name)) continue;
    const full = path.join(driveDir, name);
    try {
      fs.unlinkSync(full);
      console.log(`[publish] Removed old ${name}`);
    } catch {
      console.warn(`[publish] Could not remove ${name}`);
    }
  }
}

if (!fs.existsSync(driveDir)) {
  fs.mkdirSync(driveDir, { recursive: true });
  console.log(`[publish] Created ${driveDir}`);
}

console.log(`[publish] Arrs Hub ${version}`);
console.log(`[publish] ${signingStatusLine()}`);

const toSign = [];
let copied = 0;

for (const group of artifactGroups) {
  pruneOldOnDrive(group.prefix);
  const shaLines = [];

  for (const item of group.items) {
    const src = group.resolve(item.file);
    if (!fs.existsSync(src)) {
      console.warn(`[publish] SKIP ${item.label} — missing ${src}`);
      continue;
    }
    toSign.push(src);
    const dest = path.join(driveDir, path.basename(src));
    fs.copyFileSync(src, dest);
    const hash = sha256File(src);
    shaLines.push(`${path.basename(src)}  ${hash}`);
    console.log(`[publish] ${item.label} → ${dest}`);
    copied += 1;
  }

  if (shaLines.length > 0) {
    shaLines.push("");
    shaLines.push(signingStatusLine());
    shaLines.push(
      "Verify: Get-FileHash -Algorithm SHA256 .\\<filename>",
    );
    const shaName = `${group.prefix}-${version}-SHA256.txt`;
    const shaPath = path.join(driveDir, shaName);
    fs.writeFileSync(shaPath, `${shaLines.join("\r\n")}\r\n`, "utf8");
    console.log(`[publish] Checksums → ${shaPath}`);
  }
}

const installNotes = path.join(root, "packaging", "INSTALL-PLEX.txt");
if (fs.existsSync(installNotes)) {
  fs.copyFileSync(
    installNotes,
    path.join(driveDir, "Arrs-Hub-INSTALL-PLEX.txt"),
  );
}

if (toSign.length > 0) {
  const signed = signWindowsArtifacts(
    toSign.map((src) => path.join(driveDir, path.basename(src))),
  );
  if (signed > 0) {
    console.log(`[publish] Signed ${signed} artifact(s) on Drive.`);
  }
}

if (copied === 0) {
  console.error(
    "[publish] Nothing copied. Run npm run dist:win:all && npm run build:inno first.",
  );
  process.exit(1);
}

console.log(`[publish] Done (${copied} exe(s) + checksums in ${driveDir}).`);
