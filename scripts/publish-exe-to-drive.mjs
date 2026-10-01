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
import { readCompanionVersion } from "./companion-version.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const driveDir =
  process.env.ARRS_DRIVE_EXE_DIR || "G:\\My Drive\\exe";

const pkg = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const version = pkg.version;
const companionVersion = readCompanionVersion().version;

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
    version,
    items: [
      { label: "NSIS/Inno installer", file: `Arrs Hub-${version}-x64.exe` },
      { label: "portable", file: `Arrs Hub-${version}-portable.exe` },
    ],
    resolve: hubArtifact,
  },
  {
    prefix: "Arrs Hub Companion",
    version: companionVersion,
    items: [
      {
        label: "NSIS/Inno installer",
        file: `Arrs Hub Companion-${companionVersion}-x64.exe`,
      },
      {
        label: "portable",
        file: `Arrs Hub Companion-${companionVersion}-portable.exe`,
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

function pruneOldVersions(dir, prefix, keepVersion, extRe, tag) {
  if (!fs.existsSync(dir)) return;
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escaped}-(\\d+\\.\\d+\\.\\d+)-`);
  for (const name of fs.readdirSync(dir)) {
    const m = re.exec(name);
    if (!m || m[1] === keepVersion) continue;
    if (!extRe.test(name)) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
      console.log(`[publish] Removed old ${tag} ${name}`);
    } catch {
      console.warn(`[publish] Could not remove ${tag} ${name}`);
    }
  }
}

function pruneLocalReleaseDirs() {
  pruneOldVersions(
    path.join(root, "release"),
    "Arrs Hub",
    version,
    /\.(exe|blockmap|txt)$/i,
    "local",
  );
  pruneOldVersions(
    path.join(root, "release-companion"),
    "Arrs Hub Companion",
    companionVersion,
    /\.(exe|blockmap|txt)$/i,
    "local",
  );
  const notesDir = path.join(root, "release");
  if (!fs.existsSync(notesDir)) return;
  for (const name of fs.readdirSync(notesDir)) {
    const m = /^(?:notes-|RELEASE[-_]NOTES[-_])(\d+\.\d+\.\d+)\.md$/i.exec(name);
    if (!m || m[1] === version) continue;
    try {
      fs.unlinkSync(path.join(notesDir, name));
      console.log(`[publish] Removed old local ${name}`);
    } catch {
      /* ignore */
    }
  }
}

function sameFile(a, b) {
  if (!fs.existsSync(b)) return false;
  if (fs.statSync(a).size !== fs.statSync(b).size) return false;
  return sha256File(a) === sha256File(b);
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
  const shaLines = [];
  let groupCopied = 0;

  for (const item of group.items) {
    const src = group.resolve(item.file);
    if (!fs.existsSync(src)) {
      console.warn(`[publish] SKIP ${item.label} — missing ${src}`);
      continue;
    }
    const dest = path.join(driveDir, path.basename(src));
    const hash = sha256File(src);
    shaLines.push(`${path.basename(src)}  ${hash}`);
    if (sameFile(src, dest)) {
      console.log(`[publish] ${item.label} unchanged on Drive — ${dest}`);
      continue;
    }
    toSign.push(src);
    fs.copyFileSync(src, dest);
    console.log(`[publish] ${item.label} → ${dest}`);
    copied += 1;
    groupCopied += 1;
  }

  if (shaLines.length > 0) {
    pruneOldVersions(driveDir, group.prefix, group.version, /\.(exe|txt)$/i, "Drive");
  }

  if (groupCopied > 0) {
    shaLines.push("");
    shaLines.push(signingStatusLine());
    shaLines.push(
      "Verify: Get-FileHash -Algorithm SHA256 .\\<filename>",
    );
    const shaName = `${group.prefix}-${group.version}-SHA256.txt`;
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

pruneLocalReleaseDirs();

if (copied === 0) {
  console.log("[publish] Drive already up to date — nothing copied.");
  process.exit(0);
}

console.log(`[publish] Done (${copied} exe(s) + checksums in ${driveDir}).`);
