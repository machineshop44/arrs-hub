/**
 * Background app updates on the Companion PC (winget silent upgrade).
 */
import { spawn } from "node:child_process";

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

function runWingetUpgrade(packageId) {
  return new Promise((resolve) => {
    const args = [
      "upgrade",
      "--id",
      packageId,
      "-e",
      "--silent",
      "--accept-package-agreements",
      "--accept-source-agreements",
      "--disable-interactivity",
    ];
    const child = spawn("winget", args, {
      windowsHide: true,
      shell: true,
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
      const combined = `${stdout}\n${stderr}`.trim();
      // winget exit 0 = success; -1978335189 (0x8A15002B) often = no update
      if (code === 0) {
        resolve({
          ok: true,
          code,
          message: combined.slice(0, 400) || "Upgrade finished",
          stdout,
          stderr,
        });
        return;
      }
      const lower = combined.toLowerCase();
      if (
        lower.includes("no applicable update") ||
        lower.includes("no newer package versions") ||
        lower.includes("no available upgrade")
      ) {
        resolve({
          ok: true,
          code,
          message: "Already up to date",
          stdout,
          stderr,
        });
        return;
      }
      resolve({
        ok: false,
        code,
        message:
          combined.slice(0, 400) ||
          `winget exited with code ${code}. Is App Installer / winget installed?`,
        stdout,
        stderr,
      });
    });
  });
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
      const result = await runWingetUpgrade(WINGET_IDS[appId]);
      const next = {
        ...job,
        phase: result.ok ? "done" : "error",
        message: result.ok
          ? result.message || "Update finished"
          : result.message || "Update failed",
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
