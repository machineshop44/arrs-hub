import net from "node:net";
import { spawn } from "node:child_process";
import {
  loadWatchdogSettings,
  saveWatchdogSettings,
} from "./watchdog-store.mjs";

/**
 * @typedef {object} WatchTarget
 * @property {string} id
 * @property {string} name
 * @property {string} url
 */

/** @type {WatchTarget[]} */
let targets = [];

/** @type {Map<string, { up: boolean|null, latencyMs: number|null, lastChecked: string|null, consecutiveFails: number, lastRestartAt: string|null, lastRestartResult: string|null, message: string }>} */
const state = new Map();

/** @type {ReturnType<typeof setInterval> | null} */
let timer = null;

export function setWatchTargets(nextTargets) {
  targets = Array.isArray(nextTargets) ? nextTargets : [];
  for (const target of targets) {
    if (!state.has(target.id)) {
      state.set(target.id, {
        up: null,
        latencyMs: null,
        lastChecked: null,
        consecutiveFails: 0,
        lastRestartAt: null,
        lastRestartResult: null,
        message: "Waiting for first check",
      });
    }
  }
}

export function getWatchStatus() {
  const settings = loadWatchdogSettings();
  return {
    settings: {
      enabled: settings.enabled,
      intervalSeconds: settings.intervalSeconds,
      failThreshold: settings.failThreshold,
      restartCooldownSeconds: settings.restartCooldownSeconds,
      autoRestart: settings.autoRestart,
      services: settings.services,
    },
    targets,
    services: Object.fromEntries(
      [...state.entries()].map(([id, value]) => [id, value]),
    ),
  };
}

export function updateWatchdogSettings(partial) {
  const current = loadWatchdogSettings();
  const next = {
    ...current,
    ...partial,
    services: {
      ...current.services,
      ...(partial.services ?? {}),
    },
  };
  saveWatchdogSettings(next);
  restartWatchLoop();
  return next;
}

function hostPortFromUrl(raw) {
  try {
    const withProtocol = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)
      ? raw
      : `http://${raw}`;
    const url = new URL(withProtocol);
    const host = url.hostname;
    const port =
      url.port ||
      (url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "");
    if (!host || !port) return null;
    return { host, port: Number(port) };
  } catch {
    return null;
  }
}

function checkPort(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port });
    let settled = false;

    const finish = (up, message) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({
        up,
        latencyMs: up ? Date.now() - started : null,
        message,
      });
    };

    socket.setTimeout(timeoutMs);
    socket.on("connect", () => finish(true, "Port open"));
    socket.on("timeout", () => finish(false, "Timed out"));
    socket.on("error", (err) => finish(false, err.message || "Connection failed"));
  });
}

function startWindowsService(serviceName) {
  return new Promise((resolve) => {
    if (!serviceName?.trim()) {
      resolve({ ok: false, message: "No Windows service name configured" });
      return;
    }

    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `try { Start-Service -Name '${serviceName.replace(/'/g, "''")}' -ErrorAction Stop; 'STARTED' } catch { $_.Exception.Message }`,
      ],
      { windowsHide: true },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      const output = (stdout || stderr).trim();
      if (code === 0 && output.includes("STARTED")) {
        resolve({ ok: true, message: `Started Windows service "${serviceName}"` });
      } else {
        resolve({
          ok: false,
          message: output || `Could not start service "${serviceName}"`,
        });
      }
    });
  });
}

async function checkOne(target) {
  const settings = loadWatchdogSettings();
  const serviceCfg = settings.services[target.id] ?? {
    monitor: true,
    autoRestart: false,
    windowsService: "",
  };

  if (!settings.enabled || serviceCfg.monitor === false) {
    state.set(target.id, {
      ...(state.get(target.id) ?? {}),
      up: null,
      latencyMs: null,
      lastChecked: new Date().toISOString(),
      message: "Monitoring disabled",
    });
    return;
  }

  const parsed = hostPortFromUrl(target.url);
  if (!parsed) {
    state.set(target.id, {
      ...(state.get(target.id) ?? {}),
      up: false,
      latencyMs: null,
      lastChecked: new Date().toISOString(),
      message: "Invalid URL",
    });
    return;
  }

  const result = await checkPort(parsed.host, parsed.port);
  const prev = state.get(target.id) ?? {
    consecutiveFails: 0,
    lastRestartAt: null,
    lastRestartResult: null,
  };

  let consecutiveFails = result.up ? 0 : (prev.consecutiveFails || 0) + 1;
  let lastRestartAt = prev.lastRestartAt ?? null;
  let lastRestartResult = prev.lastRestartResult ?? null;

  const shouldRestart =
    !result.up &&
    settings.autoRestart &&
    serviceCfg.autoRestart &&
    Boolean(serviceCfg.windowsService) &&
    consecutiveFails >= settings.failThreshold;

  if (shouldRestart) {
    const last = lastRestartAt ? Date.parse(lastRestartAt) : 0;
    const cooledDown =
      Date.now() - last >= settings.restartCooldownSeconds * 1000;
    if (cooledDown) {
      const restart = await startWindowsService(serviceCfg.windowsService);
      lastRestartAt = new Date().toISOString();
      lastRestartResult = restart.message;
      consecutiveFails = 0;
    }
  }

  state.set(target.id, {
    up: result.up,
    latencyMs: result.latencyMs,
    lastChecked: new Date().toISOString(),
    consecutiveFails,
    lastRestartAt,
    lastRestartResult,
    message: result.message,
  });
}

export async function runWatchCycle() {
  const snapshot = [...targets];
  await Promise.all(snapshot.map((target) => checkOne(target)));
  return getWatchStatus();
}

export function restartWatchLoop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  const settings = loadWatchdogSettings();
  if (!settings.enabled) return;

  const intervalMs = Math.max(10, settings.intervalSeconds) * 1000;
  void runWatchCycle();
  timer = setInterval(() => {
    void runWatchCycle();
  }, intervalMs);
}

export function startWatchdog() {
  restartWatchLoop();
}
