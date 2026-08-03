import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  loadWatchdogSettings,
  saveWatchdogSettings,
} from "./watchdog-store.mjs";
import { DISCORD_COLORS, sendDiscordWebhook } from "./discord.mjs";
import {
  guessBroadcastAddress,
  isHostOnline,
  normalizeMac,
  sendWakeOnLan,
} from "./wol.mjs";

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

/** @type {Map<string, { online: boolean|null, lastChecked: string|null, consecutiveFails: number, lastWakeAt: string|null, lastWakeResult: string|null, message: string, method: string|null, downAlertSent: boolean }>} */
const pcState = new Map();

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
        mode: target.mode || "home",
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
      wolEnabled: settings.wolEnabled !== false,
      wolCooldownSeconds: settings.wolCooldownSeconds || 300,
      pcs: settings.pcs || [],
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
    pcs: Object.fromEntries([...pcState.entries()].map(([id, value]) => [id, value])),
  };
}

export function updateWatchdogSettings(partial) {
  const current = loadWatchdogSettings();
  const body = partial ?? {};
  const { discordWebhookUrl: _incomingUrl, services: partialServices, pcs, ...rest } =
    body;

  const next = {
    ...current,
    ...rest,
    discordWebhookUrl: pickSecret(body.discordWebhookUrl, current.discordWebhookUrl),
    services: {
      ...current.services,
      ...(partialServices ?? {}),
    },
    pcs: Array.isArray(pcs)
      ? pcs
          .map((pc) => ({
            id: String(pc.id || cryptoRandomId()),
            name: String(pc.name || "PC").trim() || "PC",
            host: String(pc.host || "").trim(),
            mac: normalizeMac(pc.mac) || String(pc.mac || "").trim(),
            monitor: pc.monitor !== false,
            wakeOnLan: pc.wakeOnLan !== false,
          }))
          .filter((pc) => pc.host || pc.mac)
      : current.pcs,
  };
  saveWatchdogSettings(next);
  restartWatchLoop();
  return next;
}

function cryptoRandomId() {
  return `pc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function wakePcNow(pcId) {
  const settings = loadWatchdogSettings();
  const pc = (settings.pcs || []).find((item) => item.id === pcId);
  if (!pc) throw new Error("PC not found in Wake-on-LAN list.");
  if (!normalizeMac(pc.mac)) {
    throw new Error(`Add a valid MAC address for ${pc.name}.`);
  }
  const broadcast =
    guessBroadcastAddress(pc.host) || "255.255.255.255";
  const result = await sendWakeOnLan(pc.mac, { broadcastAddress: broadcast });
  const prev = pcState.get(pc.id) ?? {};
  pcState.set(pc.id, {
    ...prev,
    lastWakeAt: new Date().toISOString(),
    lastWakeResult: `WOL sent to ${result.mac}`,
    message: `Manual WOL sent via ${broadcast}`,
  });
  return { ok: true, pc: pc.name, mac: result.mac, broadcast };
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

function splitExeArgs(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];
  const matches = text.match(/(?:[^\s"]+|"[^"]*")+/g);
  if (!matches) return [];
  return matches.map((part) =>
    part.startsWith('"') && part.endsWith('"') ? part.slice(1, -1) : part,
  );
}

function startExeProcess(exePath, exeArgs, exeCwd) {
  return new Promise((resolve) => {
    const file = String(exePath || "").trim();
    if (!file) {
      resolve({ ok: false, message: "No exe path configured" });
      return;
    }

    const args = splitExeArgs(exeArgs);
    const cwd = String(exeCwd || "").trim() || path.dirname(file);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    try {
      const child = spawn(file, args, {
        cwd,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        shell: false,
      });
      child.on("error", (err) => {
        finish({
          ok: false,
          message: err?.message || `Could not start exe "${file}"`,
        });
      });
      child.unref();
      setTimeout(() => {
        finish({
          ok: true,
          message: `Started exe "${file}"${args.length ? ` ${args.join(" ")}` : ""}`,
        });
      }, 250);
    } catch (err) {
      finish({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

/**
 * Prefer Windows service; if that fails or no service name, try optional exe.
 * @param {{ windowsService?: string, exePath?: string, exeArgs?: string, exeCwd?: string }} serviceCfg
 */
async function restartServiceOrExe(serviceCfg) {
  const serviceName = String(serviceCfg.windowsService || "").trim();
  const exePath = String(serviceCfg.exePath || "").trim();

  if (serviceName) {
    const serviceResult = await startWindowsService(serviceName);
    if (serviceResult.ok) return serviceResult;
    if (exePath) {
      const exeResult = await startExeProcess(
        exePath,
        serviceCfg.exeArgs,
        serviceCfg.exeCwd,
      );
      return {
        ok: exeResult.ok,
        message: `${serviceResult.message}; exe fallback: ${exeResult.message}`,
      };
    }
    return serviceResult;
  }

  if (exePath) {
    return startExeProcess(exePath, serviceCfg.exeArgs, serviceCfg.exeCwd);
  }

  return {
    ok: false,
    message: "No Windows service name or exe path configured",
  };
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
  const hasRestartTarget =
    Boolean(String(serviceCfg.windowsService || "").trim()) ||
    Boolean(String(serviceCfg.exePath || "").trim());
  const canRestart =
    target.allowRestart !== false &&
    target.mode !== "remote" &&
    settings.autoRestart &&
    serviceCfg.autoRestart &&
    hasRestartTarget;

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
        `Mode: **${target.mode === "remote" ? "Remote" : "Home"}**`,
        `Host: \`${parsed.host}:${parsed.port}\``,
        `Failed checks: **${consecutiveFails}** (threshold ${settings.failThreshold})`,
        `Detail: ${result.message}`,
        canRestart
          ? "Arrs Hub will try to restart the Windows service."
          : target.mode === "remote"
            ? "Remote status only — restart is Home/Plex-PC only."
            : "Auto-restart is not enabled for this app.",
      ].join("\n"),
      color: DISCORD_COLORS.down,
    });
  }

  const shouldRestart =
    !result.up &&
    canRestart &&
    consecutiveFails >= settings.failThreshold;

  if (shouldRestart) {
    const last = lastRestartAt ? Date.parse(lastRestartAt) : 0;
    const cooledDown =
      Date.now() - last >= settings.restartCooldownSeconds * 1000;
    if (cooledDown) {
      const restart = await restartServiceOrExe(serviceCfg);
      lastRestartAt = new Date().toISOString();
      lastRestartResult = restart.message;
      consecutiveFails = 0;

      if (settings.discordNotifyRestart !== false) {
        await notifyDiscord(settings, {
          title: restart.ok
            ? `${target.name} restart succeeded`
            : `${target.name} restart failed`,
          description: [
            serviceCfg.windowsService
              ? `Service: \`${serviceCfg.windowsService}\``
              : "Service: (none)",
            serviceCfg.exePath
              ? `Exe: \`${serviceCfg.exePath}\``
              : "Exe: (none)",
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
    message:
      target.mode === "remote"
        ? result.up
          ? "Remote port open"
          : result.message || "Remote unreachable"
        : result.message,
    downAlertSent,
    mode: target.mode || "home",
  });
}

export async function runWatchCycle() {
  const snapshot = [...targets];
  await Promise.all(snapshot.map((target) => checkOne(target)));
  await checkPcs();
  return getWatchStatus();
}

async function checkPcs() {
  const settings = loadWatchdogSettings();
  if (!settings.enabled) return;
  const pcs = Array.isArray(settings.pcs) ? settings.pcs : [];

  for (const pc of pcs) {
    if (!pc.monitor || !pc.host) {
      pcState.set(pc.id, {
        ...(pcState.get(pc.id) ?? {}),
        online: null,
        lastChecked: new Date().toISOString(),
        message: pc.monitor ? "No host/IP set" : "Monitoring disabled",
        method: null,
      });
      continue;
    }

    const prev = pcState.get(pc.id) ?? {
      consecutiveFails: 0,
      lastWakeAt: null,
      lastWakeResult: null,
      downAlertSent: false,
      online: null,
    };

    const probe = await isHostOnline(pc.host);
    let consecutiveFails = probe.online ? 0 : (prev.consecutiveFails || 0) + 1;
    let lastWakeAt = prev.lastWakeAt ?? null;
    let lastWakeResult = prev.lastWakeResult ?? null;
    let downAlertSent = Boolean(prev.downAlertSent);
    let message = probe.message;

    if (probe.online) downAlertSent = false;

    const wasOffline = prev.online === false;
    if (probe.online && wasOffline && settings.discordNotifyRecovered !== false) {
      await notifyDiscord(settings, {
        title: `${pc.name} is back online`,
        description: `Host \`${pc.host}\` responded (${probe.method || "ok"}).`,
        color: DISCORD_COLORS.recovered,
      });
    }

    if (
      !probe.online &&
      !downAlertSent &&
      consecutiveFails >= settings.failThreshold &&
      settings.discordNotifyDown !== false
    ) {
      downAlertSent = true;
      await notifyDiscord(settings, {
        title: `${pc.name} appears offline`,
        description: [
          `Host: \`${pc.host}\``,
          `MAC: \`${pc.mac || "not set"}\``,
          `Failed checks: **${consecutiveFails}**`,
          settings.wolEnabled !== false && pc.wakeOnLan && normalizeMac(pc.mac)
            ? "Sending Wake-on-LAN (LAN only)."
            : "Wake-on-LAN not configured/enabled for this PC.",
        ].join("\n"),
        color: DISCORD_COLORS.down,
      });
    }

    const shouldWake =
      !probe.online &&
      settings.wolEnabled !== false &&
      pc.wakeOnLan &&
      Boolean(normalizeMac(pc.mac)) &&
      consecutiveFails >= settings.failThreshold;

    if (shouldWake) {
      const last = lastWakeAt ? Date.parse(lastWakeAt) : 0;
      const cooled =
        Date.now() - last >= (settings.wolCooldownSeconds || 300) * 1000;
      if (cooled) {
        try {
          const broadcast =
            guessBroadcastAddress(pc.host) || "255.255.255.255";
          const wol = await sendWakeOnLan(pc.mac, {
            broadcastAddress: broadcast,
          });
          lastWakeAt = new Date().toISOString();
          lastWakeResult = `WOL sent to ${wol.mac} via ${broadcast}`;
          message = lastWakeResult;
          consecutiveFails = 0;
          if (settings.discordNotifyRestart !== false) {
            await notifyDiscord(settings, {
              title: `${pc.name} Wake-on-LAN sent`,
              description: lastWakeResult,
              color: DISCORD_COLORS.restartOk,
            });
          }
        } catch (err) {
          lastWakeAt = new Date().toISOString();
          lastWakeResult = err instanceof Error ? err.message : String(err);
          message = `WOL failed: ${lastWakeResult}`;
          if (settings.discordNotifyRestart !== false) {
            await notifyDiscord(settings, {
              title: `${pc.name} Wake-on-LAN failed`,
              description: lastWakeResult,
              color: DISCORD_COLORS.restartFail,
            });
          }
        }
      }
    }

    pcState.set(pc.id, {
      online: probe.online,
      lastChecked: new Date().toISOString(),
      consecutiveFails,
      lastWakeAt,
      lastWakeResult,
      message,
      method: probe.method,
      downAlertSent,
    });
  }
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
