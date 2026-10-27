/**
 * Background app updates on the Companion PC.
 * Prefer winget; if the app was not installed via winget or needs admin, fall back
 * to an elevated winget install, then to a silent GitHub/SourceForge installer.
 *
 * Important: website installs are often invisible to `winget upgrade`, and winget may
 * report "already up to date" while the Hub still sees a newer GitHub/SourceForge
 * release. We always re-check the local EXE version against targetVersion.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { getLocalAppVersions } from "./local-app-versions.mjs";

const WINGET_IDS = {
  qbittorrent: "qBittorrent.qBittorrent",
  sabnzbd: "SABnzbd.SABnzbd",
};

const LABELS = {
  qbittorrent: "qBittorrent",
  sabnzbd: "SABnzbd",
};

/** @param {string} raw */
function shortVer(raw) {
  const text = String(raw || "").trim().replace(/^v/i, "");
  if (!text) return "";
  const match = text.match(/(\d+\.\d+(?:\.\d+)?(?:\.\d+)?)/);
  return match ? match[1] : text.slice(0, 16);
}

/** Exported for tests. */
export function compareSemver(a, b) {
  const pa = String(a || "")
    .split(/[.+-]/)
    .map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b || "")
    .split(/[.+-]/)
    .map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

async function readLocalVersion(appId) {
  try {
    const data = await getLocalAppVersions();
    const row = (data?.apps || []).find((a) => a.id === appId);
    return shortVer(row?.version) || null;
  } catch {
    return null;
  }
}

/** @type {Map<string, object>} */
const jobsById = new Map();
/** @type {object | null} */
let lastJob = null;
let jobSeq = 0;

export function supportedCompanionUpdateIds() {
  return Object.keys(WINGET_IDS);
}

function idleJob(appId = null) {
  return {
    id: null,
    appId: appId || null,
    label: appId ? LABELS[appId] || appId : null,
    phase: "idle",
    message: "No update job running.",
    error: null,
    startedAt: null,
    finishedAt: null,
  };
}

export function getCompanionAppUpdateJob(appId) {
  const id = String(appId || "").trim();
  if (id && jobsById.has(id)) return { ...jobsById.get(id) };
  if (lastJob && (!id || lastJob.appId === id)) return { ...lastJob };
  return idleJob(id || null);
}

/** Exported for tests — find a real winget.exe (not a dead App Execution Alias). */
export function resolveWingetPath() {
  const localApps = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
    "Microsoft",
    "WindowsApps",
    "winget.exe",
  );
  const candidates = [localApps];
  try {
    const root = path.join(process.env.ProgramFiles || "C:\\Program Files", "WindowsApps");
    if (fs.existsSync(root)) {
      for (const name of fs.readdirSync(root)) {
        if (!/^Microsoft\.DesktopAppInstaller_/i.test(name)) continue;
        candidates.push(path.join(root, name, "winget.exe"));
      }
    }
  } catch {
    /* ignore */
  }
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).size > 0) {
        return candidate;
      }
    } catch {
      /* ignore */
    }
  }
  return "winget.exe";
}

function spawnCapture(command, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true,
      shell: false,
      ...opts,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => {
      resolve({
        ok: false,
        code: null,
        message: err.message || String(err),
        stdout,
        stderr,
      });
    });
    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        code,
        message: `${stdout}\n${stderr}`.trim(),
        stdout,
        stderr,
      });
    });
  });
}

/** Exported for tests. */
export function interpretWingetOutput(result) {
  const combined = String(result?.message || "");
  const lower = combined.toLowerCase();
  if (result?.ok || result?.code === 0) {
    const already =
      lower.includes("already installed") ||
      lower.includes("no applicable update") ||
      lower.includes("no newer package versions");
    return {
      ok: true,
      alreadyCurrent: already,
      message: already ? "Already up to date" : combined.slice(0, 400) || "Upgrade finished",
    };
  }
  // APPINSTALLER_CLI_ERROR_UPDATE_NOT_APPLICABLE / already current
  if (
    result?.code === -1978335189 ||
    lower.includes("no applicable update") ||
    lower.includes("no newer package versions") ||
    lower.includes("no available upgrade") ||
    lower.includes("already installed")
  ) {
    return { ok: true, alreadyCurrent: true, message: "Already up to date" };
  }
  if (
    lower.includes("no installed package found") ||
    lower.includes("no package found matching")
  ) {
    return {
      ok: false,
      retryInstall: true,
      message: combined.slice(0, 400) || "Package not tracked by winget",
    };
  }
  if (
    lower.includes("administrator") ||
    lower.includes("elevation") ||
    lower.includes("access is denied") ||
    lower.includes("requires interactive") ||
    lower.includes("uac cancelled") ||
    result?.code === -1978335215
  ) {
    return {
      ok: false,
      needsElevation: true,
      message: combined.slice(0, 400) || "Needs administrator approval",
    };
  }
  return {
    ok: false,
    message:
      combined.slice(0, 400) ||
      `winget exited with code ${result?.code}. Is App Installer / winget installed?`,
  };
}

function wingetArgs(mode, packageId, { version = null } = {}) {
  const ver = shortVer(version);
  return [
    mode,
    "--id",
    packageId,
    "-e",
    "--silent",
    "--accept-package-agreements",
    "--accept-source-agreements",
    "--disable-interactivity",
    ...(ver ? ["--version", ver] : []),
    ...(mode === "upgrade" ? ["--include-unknown"] : ["--force"]),
  ];
}

async function refreshWingetSource() {
  const winget = resolveWingetPath();
  await spawnCapture(winget, ["source", "update", "--disable-interactivity"]);
}

async function runWinget(mode, packageId, { elevated = false, version = null } = {}) {
  const winget = resolveWingetPath();
  const args = wingetArgs(mode, packageId, { version });
  if (!elevated) {
    const raw = await spawnCapture(winget, args);
    return { ...interpretWingetOutput(raw), raw };
  }
  // One UAC prompt — same pattern as Companion's firewall fix.
  const argLine = args.map((a) => `"${String(a).replace(/"/g, '\\"')}"`).join(" ");
  const ps = `
$p = Start-Process -FilePath ${JSON.stringify(winget)} -ArgumentList ${JSON.stringify(argLine)} -Verb RunAs -Wait -PassThru -WindowStyle Hidden
if (-not $p) { Write-Error 'UAC cancelled or Start-Process failed'; exit 1 }
exit $p.ExitCode
`;
  const raw = await spawnCapture("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    ps,
  ]);
  return { ...interpretWingetOutput(raw), raw };
}

async function downloadToTemp(url, filename) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arrs-hub-update-"));
  const dest = path.join(dir, filename);
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "Arrs-Hub-Companion" },
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`Download failed HTTP ${res.status} for ${url}`);
  if (!res.body) throw new Error("Download returned an empty body");
  await pipeline(res.body, createWriteStream(dest));
  return dest;
}

async function runSilentInstaller(exePath) {
  // Both qBit and SAB NSIS installers accept /S.
  const raw = await spawnCapture(exePath, ["/S"]);
  if (raw.ok || raw.code === 0) {
    return { ok: true, message: "Installer finished" };
  }
  // Elevate if the existing install is under Program Files.
  const argLine = "/S";
  const ps = `
$p = Start-Process -FilePath ${JSON.stringify(exePath)} -ArgumentList ${JSON.stringify(argLine)} -Verb RunAs -Wait -PassThru
if (-not $p) { Write-Error 'UAC cancelled'; exit 1 }
exit $p.ExitCode
`;
  const elevated = await spawnCapture("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps]);
  if (elevated.ok || elevated.code === 0) {
    return { ok: true, message: "Installer finished (elevated)" };
  }
  return {
    ok: false,
    message: elevated.message.slice(0, 400) || `Installer exited ${elevated.code}`,
  };
}

/** Pick a Windows x64 setup EXE from GitHub release assets. */
export function pickWindowsSetupAsset(assets = []) {
  const list = Array.isArray(assets) ? assets : [];
  const scored = list
    .map((a) => {
      const name = String(a?.name || "");
      const url = String(a?.browser_download_url || "");
      if (!url || !/\.exe$/i.test(name)) return null;
      if (/debug|symbols|pdb|arm|win32|x86(?!_64)/i.test(name) && !/x64|win64|64bit|64-bit/i.test(name)) {
        return null;
      }
      let score = 0;
      if (/setup|installer|win64|x64|64/i.test(name)) score += 5;
      if (/qbittorrent|sabnzbd/i.test(name)) score += 2;
      if (/portable/i.test(name)) score -= 3;
      return { name, url, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  return scored[0] || null;
}

async function githubLatestSetup(repo) {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "Arrs-Hub-Companion",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GitHub releases HTTP ${res.status} for ${repo}`);
  const data = await res.json();
  const asset = pickWindowsSetupAsset(data?.assets);
  if (!asset) {
    throw new Error(`No Windows setup .exe on the latest ${repo} release (may only publish source).`);
  }
  return asset;
}

/** Exported for tests — official Windows x64 NSIS setup on SourceForge. */
export function qbitSourceForgeSetup(version) {
  const ver = shortVer(version);
  if (!ver) return null;
  const name = `qbittorrent_${ver}_x64_setup.exe`;
  return {
    name,
    url: `https://sourceforge.net/projects/qbittorrent/files/qbittorrent-win32/qbittorrent-${ver}/${name}/download`,
  };
}

async function runGithubInstallerFallback(appId) {
  const repos = {
    qbittorrent: "qbittorrent/qBittorrent",
    sabnzbd: "sabnzbd/sabnzbd",
  };
  const repo = repos[appId];
  if (!repo) return { ok: false, message: `No GitHub fallback for ${appId}` };
  try {
    const asset = await githubLatestSetup(repo);
    const exe = await downloadToTemp(asset.url, asset.name);
    try {
      return await runSilentInstaller(exe);
    } finally {
      try {
        fs.rmSync(path.dirname(exe), { recursive: true, force: true });
      } catch {
        /* temp cleanup best-effort */
      }
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

async function runSourceForgeQbitFallback(version) {
  const asset = qbitSourceForgeSetup(version);
  if (!asset) {
    return { ok: false, message: "No qBittorrent version for SourceForge download" };
  }
  try {
    const exe = await downloadToTemp(asset.url, asset.name);
    try {
      return await runSilentInstaller(exe);
    } finally {
      try {
        fs.rmSync(path.dirname(exe), { recursive: true, force: true });
      } catch {
        /* temp cleanup best-effort */
      }
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

async function localStillBehind(appId, targetVersion) {
  const target = shortVer(targetVersion);
  if (!target) return false;
  const local = await readLocalVersion(appId);
  if (!local) return true;
  return compareSemver(local, target) < 0;
}

async function finalizeSuccess(appId, label, targetVersion, result) {
  const local = await readLocalVersion(appId);
  const target = shortVer(targetVersion);
  if (target && local && compareSemver(local, target) < 0) {
    return {
      ok: false,
      message: `${label} still reports v${local} after update (want v${target}). Approve UAC on this PC if prompted, then retry.`,
    };
  }
  if (target && !local) {
    return {
      ok: false,
      message: `${label} update claimed success but the installed EXE version could not be read.`,
    };
  }
  return {
    ok: true,
    message: local
      ? `${label} is now v${local}`
      : `${label}: ${result.message || "Update finished"}`,
  };
}

/**
 * @param {string} appId
 * @param {{ targetVersion?: string|null }} [opts]
 */
async function upgradeApp(appId, opts = {}) {
  const packageId = WINGET_IDS[appId];
  const label = LABELS[appId] || appId;
  const targetVersion = shortVer(opts.targetVersion) || null;

  try {
    await refreshWingetSource();
  } catch {
    /* source refresh is best-effort */
  }

  let result = await runWinget("upgrade", packageId, { version: targetVersion });
  if (result.ok && !(result.alreadyCurrent && (await localStillBehind(appId, targetVersion)))) {
    return finalizeSuccess(appId, label, targetVersion, result);
  }

  // Website installs (or stale winget) often need a forced install of the target version.
  const forceVersion = targetVersion || undefined;
  result = await runWinget("install", packageId, { version: forceVersion });
  if (result.ok && !(result.alreadyCurrent && (await localStillBehind(appId, targetVersion)))) {
    return finalizeSuccess(appId, label, targetVersion, result);
  }

  result = await runWinget("install", packageId, {
    elevated: true,
    version: forceVersion,
  });
  if (result.ok && !(result.alreadyCurrent && (await localStillBehind(appId, targetVersion)))) {
    const finalized = await finalizeSuccess(appId, label, targetVersion, result);
    if (finalized.ok) {
      return { ...finalized, message: `${finalized.message} (admin)` };
    }
    result = { ...result, ok: false, message: finalized.message };
  }

  let fallback = { ok: false, message: "" };
  if (appId === "qbittorrent") {
    fallback = await runSourceForgeQbitFallback(targetVersion);
  } else {
    fallback = await runGithubInstallerFallback(appId);
  }
  if (fallback.ok) {
    return finalizeSuccess(appId, label, targetVersion, {
      message: `${fallback.message} via vendor installer`,
    });
  }

  const local = await readLocalVersion(appId);
  return {
    ok: false,
    message: [
      result.message,
      local && targetVersion
        ? `Installed v${local}, Hub wants v${targetVersion}.`
        : "",
      fallback.message && fallback.message !== result.message
        ? `Fallback: ${fallback.message}`
        : "",
      "Approve the UAC prompt on this PC if one appeared, or reinstall once with winget so future updates work.",
    ]
      .filter(Boolean)
      .join(" — ")
      .slice(0, 500),
  };
}

/**
 * @param {{ id?: string, targetVersion?: string }} body
 */
export function startCompanionAppUpdate(body = {}) {
  const appId = String(body.id || "").trim();
  if (!WINGET_IDS[appId]) {
    const err = new Error(
      `Background update not supported for "${appId}". Supported: ${supportedCompanionUpdateIds().join(", ")}`,
    );
    err.code = "UNSUPPORTED";
    throw err;
  }
  const existing = jobsById.get(appId);
  if (existing?.phase === "running") {
    const err = new Error(`${LABELS[appId] || appId} update already running.`);
    err.code = "JOB_IN_PROGRESS";
    throw err;
  }

  const targetVersion = shortVer(body.targetVersion) || null;
  const job = {
    id: `companion-app-update-${Date.now()}-${++jobSeq}`,
    appId,
    label: LABELS[appId] || appId,
    phase: "running",
    message: targetVersion
      ? `Updating ${LABELS[appId] || appId} toward v${targetVersion}…`
      : `Starting ${LABELS[appId] || appId} update via winget…`,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  jobsById.set(appId, job);
  lastJob = job;

  void (async () => {
    try {
      const result = await upgradeApp(appId, { targetVersion });
      const next = {
        ...job,
        phase: result.ok ? "done" : "error",
        message: result.message || (result.ok ? "Update finished" : "Update failed"),
        error: result.ok ? null : result.message || "Update failed",
        finishedAt: new Date().toISOString(),
      };
      jobsById.set(appId, next);
      lastJob = next;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const next = {
        ...job,
        phase: "error",
        message,
        error: message,
        finishedAt: new Date().toISOString(),
      };
      jobsById.set(appId, next);
      lastJob = next;
    }
  })();

  return { ...job };
}
