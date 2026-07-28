import net from "node:net";
import { spawn } from "node:child_process";
import {
  loadWatchdogSettings,
  saveWatchdogSettings,
} from "./watchdog-store.mjs";
import { DISCORD_COLORS, sendDiscordWebhook } from "./discord.mjs";

/**
 * @typedef {object} WatchTarget
 * @property {string} id
 * @property {string} name
 * @property {string} url
 */

/** @type {WatchTarget[]} */
let targets = [];

/** @type {Map<string, { up: boolean|null, latencyMs: number|null, lastChecked: string|null, consecutiveFails: number, lastRestartAt: string|null, lastRestartResult: string|null, message: string, downAlertSent: boolean }>} */
const state = new Map();

/** @type {ReturnType<typeof setInterval> | null} */
let timer = null;

function maskWebhook(url) {
  if (!url) return "";
  if (url.length <= 24) return "••••••••";
  return `${url.slice(0, 40)}…${url.slice(-6)}`;
}

function pickSecret(incoming, current) {
  if (typeof incoming !== "string") return current;
  const trimmed = incoming.trim();
  if (!trimmed) return current;
  if (trimmed.includes("…") || trimmed.includes("•")) return current;
  return trimmed;
}

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
        downAlertSent: false,
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
      discordWebhookUrl: settings.discordWebhookUrl
        ? maskWebhook(settings.discordWebhookUrl)
        : "",
      discordWebhookSet: Boolean(settings.discordWebhookUrl),
      discordNotifyDown: settings.discordNotifyDown !== false,
      discordNotifyRestart: settings.discordNotifyRestart !== false,
      discordNotifyRecovered: settings.discordNotifyRecovered !== false,
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
  const body = partial ?? {};
  const { discordWebhookUrl: _incomingUrl, services: partialServices, ...rest } =
    body;

  const next = {
    ...current,
    ...rest,
    discordWebhookUrl: pickSecret(body.discordWebhookUrl, current.discordWebhookUrl),
    services: {
      ...current.services,
      ...(partialServices ?? {}),
    },
  };
  saveWatchdogSettings(next);
  restartWatchLoop();
  return next;
}

export async function testDiscordWebhook() {
  const settings = loadWatchdogSettings();
  if (!settings.discordWebhookUrl) {
    return { ok: false, message: "No Discord webhook URL saved yet." };
  }
  return sendDiscordWebhook(settings.discordWebhookUrl, {
    title: "Arrs Hub test",
    description:
      "Port Watch can reach Discord. You’ll get alerts when a monitored port goes down and when a restart succeeds or fails.",
    color: DISCORD_COLORS.test,
  });
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

async function notifyDiscord(settings, payload) {
  if (!settings.discordWebhookUrl) return;
  const result = await sendDiscordWebhook(settings.discordWebhookUrl, payload);
  if (!result.ok) {
    console.error("Discord webhook failed:", result.message);
  }
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
    downAlertSent: false,
    up: null,
  };

  let consecutiveFails = result.up ? 0 : (prev.consecutiveFails || 0) + 1;
  let lastRestartAt = prev.lastRestartAt ?? null;
  let lastRestartResult = prev.lastRestartResult ?? null;
  let downAlertSent = Boolean(prev.downAlertSent);

  const wasDown = prev.up === false;
  const recovered = result.up && wasDown;

  if (result.up) {
    downAlertSent = false;
  }

  // Alert once when failures hit the threshold (not every check while down)
  if (
    !result.up &&
    !downAlertSent &&
    consecutiveFails >= settings.failThreshold &&
    settings.discordNotifyDown !== false
  ) {
    downAlertSent = true;
    await notifyDiscord(settings, {
      title: `${target.name} port is down`,
      description: [
        `Host: \`${parsed.host}:${parsed.port}\``,
        `Failed checks: **${consecutiveFails}** (threshold ${settings.failThreshold})`,
        `Detail: ${result.message}`,
        settings.autoRestart && serviceCfg.autoRestart && serviceCfg.windowsService
          ? "Arrs Hub will try to restart the Windows service."
          : "Auto-restart is not enabled for this app.",
      ].join("\n"),
      color: DISCORD_COLORS.down,
    });
  }

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

      if (settings.discordNotifyRestart !== false) {
        await notifyDiscord(settings, {
          title: restart.ok
            ? `${target.name} restart succeeded`
            : `${target.name} restart failed`,
          description: [
            `Service: \`${serviceCfg.windowsService}\``,
            restart.message,
            `Checked port: \`${parsed.host}:${parsed.port}\``,
          ].join("\n"),
          color: restart.ok
            ? DISCORD_COLORS.restartOk
            : DISCORD_COLORS.restartFail,
        });
      }
    }
  }

  if (recovered && settings.discordNotifyRecovered !== false) {
    await notifyDiscord(settings, {
      title: `${target.name} is back up`,
      description: `Port \`${parsed.host}:${parsed.port}\` is responding again${
        result.latencyMs != null ? ` (${result.latencyMs} ms)` : ""
      }.`,
      color: DISCORD_COLORS.recovered,
    });
  }

  state.set(target.id, {
    up: result.up,
    latencyMs: result.latencyMs,
    lastChecked: new Date().toISOString(),
    consecutiveFails,
    lastRestartAt,
    lastRestartResult,
    message: result.message,
    downAlertSent,
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
