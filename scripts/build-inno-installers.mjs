/**
 * Compile Inno Setup installers from electron-builder win-unpacked folders.
 * Matches ytarr / Market Advisor publish flow (lighter wizard than NSIS).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signWindowsArtifacts } from "./sign-windows-artifacts.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const pkg = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const version = pkg.version;

const PRODUCTS = [
  {
    id: "hub",
    label: "Arrs Hub",
    iss: path.join(root, "packaging", "arrs-hub.iss"),
    unpacked: path.join(root, "release", "win-unpacked"),
    outputDir: path.join(root, "release"),
    installerName: `Arrs Hub-${version}-x64.exe`,
  },
  {
    id: "companion",
    label: "Arrs Hub Companion",
    iss: path.join(root, "packaging", "arrs-hub-companion.iss"),
    unpacked: path.join(root, "release-companion", "win-unpacked"),
    outputDir: path.join(root, "release-companion"),
    installerName: `Arrs Hub Companion-${version}-x64.exe`,
  },
];

function findIscc() {
  const fromEnv = process.env.INNO_SETUP_ISCC?.trim();
  const candidates = [
    fromEnv,
    "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe",
    "C:\\Program Files\\Inno Setup 6\\ISCC.exe",
    path.join(
      process.env.LOCALAPPDATA || "",
      "Programs",
      "Inno Setup 6",
      "ISCC.exe",
    ),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function buildOne(iscc, product) {
  if (!fs.existsSync(product.unpacked)) {
    throw new Error(
      `${product.label}: missing ${product.unpacked} — run electron-builder --win first`,
    );
  }
  const exeName =
    product.id === "hub" ? "Arrs Hub.exe" : "Arrs Hub Companion.exe";
  if (!fs.existsSync(path.join(product.unpacked, exeName))) {
    throw new Error(`${product.label}: ${exeName} not found in win-unpacked`);
  }

  fs.mkdirSync(product.outputDir, { recursive: true });
  console.log(`[inno] Compiling ${product.label} ${version} …`);
  const result = spawnSync(
    iscc,
    [`/DMyAppVersion=${version}`, product.iss],
    { cwd: root, stdio: "inherit", windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error(`Inno Setup failed for ${product.label} (exit ${result.status})`);
  }

  const installerPath = path.join(product.outputDir, product.installerName);
  if (!fs.existsSync(installerPath)) {
    throw new Error(`Expected installer missing: ${installerPath}`);
  }
  const mb = (fs.statSync(installerPath).size / (1024 * 1024)).toFixed(1);
  console.log(`[inno] ${product.installerName} (${mb} MB)`);
  return installerPath;
}

const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const iscc = findIscc();
if (!iscc) {
  console.error(
    "[inno] Inno Setup 6 not found. Install: winget install JRSoftware.InnoSetup",
  );
  process.exit(1);
}

const selected =
  only.length > 0
    ? PRODUCTS.filter((p) => only.includes(p.id))
    : PRODUCTS;

if (selected.length === 0) {
  console.error("[inno] Unknown product id. Use: hub companion");
  process.exit(1);
}

const built = [];
for (const product of selected) {
  built.push(buildOne(iscc, product));
}

signWindowsArtifacts(built);
console.log("[inno] Done.");
