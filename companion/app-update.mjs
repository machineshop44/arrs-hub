/**
 * Background app updates on the Companion PC.
 * Prefer winget; if the app was not installed via winget or needs admin, fall back
 * to an elevated winget install, then to a silent GitHub/SourceForge installer.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";

const WINGET_IDS = {
  qbittorrent: "qBittorrent.qBittorrent",
  sabnzbd: "SABnzbd.SABnzbd",
};

const LABELS = {
  qbittorrent: "qBittorrent",
  sabnzbd: "SABnzbd",
};

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
    return { ok: true, message: combined.slice(0, 400) || "Upgrade finished" };
  }
  // APPINSTALLER_CLI_ERROR_UPDATE_NOT_APPLICABLE / already current
  if (
    result?.code === -1978335189 ||
    lower.includes("no applicable update") ||
    lower.includes("no newer package versions") ||
    lower.includes("no available upgrade") ||
    lower.includes("already installed")
  ) {
    return { ok: true, message: "Already up to date" };
  }
  if (
    lower.includes("no installed package found") ||
    lower.includes("no package found matching") ||
    lower.includes("no available upgrade")
  ) {
    return { ok: false, retryInstall: true, message: combined.slice(0, 400) || "Package not tracked by winget" };
  }
  if (
    lower.includes("administrator") ||
    lower.includes("elevation") ||
    lower.includes("access is denied") ||
    lower.includes("requires interactive") ||
    result?.code === -1978335215
  ) {
    return { ok: false, needsElevation: true, message: combined.slice(0, 400) || "Needs administrator approval" };
  }
  return {
    ok: false,
    message:
      combined.slice(0, 400) ||
      `winget exited with code ${result?.code}. Is App Installer / winget installed?`,
  };
}

function wingetArgs(mode, packageId) {
  return [
    mode,
    "--id",
    packageId,
    "-e",
    "--silent",
    "--accept-package-agreements",
    "--accept-source-agreements",
    "--disable-interactivity",
    ...(mode === "upgrade" ? ["--include-unknown"] : ["--force"]),
  ];
}

async function runWinget(mode, packageId, { elevated = false } = {}) {
  const winget = resolveWingetPath();
  const args = wingetArgs(mode, packageId);
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
  const raw = await spawnCapture("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps]);
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

async function upgradeApp(appId) {
  const packageId = WINGET_IDS[appId];
  const label = LABELS[appId] || appId;

  let result = await runWinget("upgrade", packageId);
  if (result.ok) {
    return { ok: true, message: `${label}: ${result.message}` };
  }

  if (result.retryInstall) {
    result = await runWinget("install", packageId);
    if (result.ok) return { ok: true, message: `${label}: ${result.message}` };
  }

  if (result.needsElevation || result.retryInstall) {
    result = await runWinget(result.retryInstall ? "install" : "upgrade", packageId, { elevated: true });
    if (result.ok) {
      return { ok: true, message: `${label}: ${result.message} (admin)` };
    }
  }

  // Last resort: pull the vendor installer (SAB publishes win setup on GitHub; qBit often does not).
  const fallback = await runGithubInstallerFallback(appId);
  if (fallback.ok) {
    return { ok: true, message: `${label}: ${fallback.message} via vendor installer` };
  }

  return {
    ok: false,
    message:
      [
        result.message,
        fallback.message && fallback.message !== result.message ? `Fallback: ${fallback.message}` : "",
        "If the app was installed from the website, approve the UAC prompt or reinstall once with winget so future updates work.",
      ]
        .filter(Boolean)
        .join(" — ")
        .slice(0, 500),
  };
}

/**
 * @param {{ id?: string }} body
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

  const job = {
    id: `companion-app-update-${Date.now()}-${++jobSeq}`,
    appId,
    label: LABELS[appId] || appId,
    phase: "running",
    message: `Starting ${LABELS[appId] || appId} update via winget…`,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  jobsById.set(appId, job);
  lastJob = job;

  void (async () => {
    try {
      const result = await upgradeApp(appId);
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
