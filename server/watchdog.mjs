import net from "node:net";
import {
  guessBroadcastAddress,
  isHostOnline,
  normalizeMac,
  sendWakeOnLan,
} from "./wol.mjs";
import {
  loadWatchdogSettings,
  saveWatchdogSettings,
} from "./watchdog-store.mjs";
import { DISCORD_COLORS, sendDiscordWebhook } from "./discord.mjs";
import {
  checkCompanionHealth,
  requestCompanionRestart,
  requestCompanionServiceStatus,
} from "./companion-client.mjs";
import { restartServiceOrExe } from "./restart-windows.mjs";

/**
 * @typedef {object} WatchTarget
 * @property {string} id
 * @property {string} name
 * @property {string} url
 * @property {"home"|"remote"} [mode]
 * @property {boolean} [allowRestart]
 * @property {"tcp"|"companion"} [probe]
 */

const COMPANION_PROBE_URL = "companion://local";

function wantsCompanionProbe(target, serviceCfg) {
  if (target?.probe === "companion") return true;
  const url = String(target?.url || "").trim().toLowerCase();
  if (url.startsWith("companion:")) return true;
  if (String(target?.id || "") === "fileflows-node") return true;
  // No TCP URL but Companion restart PC is set - ask Companion.
  if (!hostPortFromUrl(target?.url) && String(serviceCfg?.restartPcId || "").trim()) {
    return true;
  }
  return false;
}

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
      pcs: (settings.pcs || []).map((pc) => ({
        id: pc.id,
        name: pc.name,
        host: pc.host,
        mac: pc.mac,
        monitor: pc.monitor,
        wakeOnLan: pc.wakeOnLan,
        companionUrl: pc.companionUrl || "",
        companionApiKeySet: Boolean(pc.companionApiKey),
        companionId: pc.companionId || "",
        lastRegisterAt: pc.lastRegisterAt || null,
      })),
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
          .map((pc) => {
            const prev = (current.pcs || []).find((item) => item.id === pc.id);
            return {
              id: String(pc.id || cryptoRandomId()),
              name: String(pc.name || "PC").trim() || "PC",
              host: String(pc.host || "").trim(),
              mac: normalizeMac(pc.mac) || String(pc.mac || "").trim(),
              monitor: pc.monitor !== false,
              wakeOnLan: pc.wakeOnLan !== false,
              companionUrl: String(pc.companionUrl || "").trim(),
              companionApiKey: pickSecret(
                pc.companionApiKey,
                prev?.companionApiKey || "",
              ),
              companionId: String(pc.companionId || prev?.companionId || "").trim(),
              lastRegisterAt: prev?.lastRegisterAt || null,
            };
          })
          .filter((pc) => pc.host || pc.mac || pc.companionUrl)
      : current.pcs,
  };
  saveWatchdogSettings(next);
  restartWatchLoop();
  return next;
}

function cryptoRandomId() {
  return `pc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function wakeByMacNow(macRaw, hostHint = "") {
  const mac = normalizeMac(macRaw);
  if (!mac) {
    throw new Error("MAC address must look like AA:BB:CC:DD:EE:FF");
  }
  const broadcast =
    guessBroadcastAddress(hostHint) || "255.255.255.255";
  const result = await sendWakeOnLan(mac, { broadcastAddress: broadcast });
  return {
    ok: true,
    mac: result.mac,
    broadcast,
    message: `Wake-on-LAN sent to ${result.mac} via ${broadcast}`,
  };
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
  return {
    ok: true,
    pc: pc.name,
    mac: result.mac,
    broadcast,
    message: `Wake-on-LAN sent for ${pc.name}`,
  };
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

async function restartForService(serviceCfg, settings) {
  const pcId = String(serviceCfg.restartPcId || "").trim();
  if (!pcId) {
    return restartServiceOrExe(serviceCfg);
  }

  const pc = (settings.pcs || []).find((item) => item.id === pcId);
  if (!pc) {
    return { ok: false, message: "Companion PC not found in Port Watch settings." };
  }
  if (!String(pc.companionUrl || "").trim()) {
    return {
      ok: false,
      message: `Set Companion URL on "${pc.name || "PC"}" in Port Watch.`,
    };
  }

  const live = pcState.get(pcId);
  if (live?.online !== true) {
    return {
      ok: false,
      message: `Companion PC offline (${pc.name || pc.host}) — Wake-on-LAN may be pending.`,
    };
  }

  const result = await requestCompanionRestart(
    pc.companionUrl,
    pc.companionApiKey,
    serviceCfg,
  );
  if (result.ok) {
    return {
      ok: true,
      message: `Companion restart: ${result.message}`,
    };
  }
  return result;
}

async function notifyDiscord(settings, payload) {
  if (!settings.discordWebhookUrl) return;
  const result = await sendDiscordWebhook(settings.discordWebhookUrl, payload);
  if (!result.ok) {
    console.error("Discord webhook failed:", result.message);
  }
}

async function probeViaCompanion(target, serviceCfg, settings) {
  const pcId = String(serviceCfg.restartPcId || "").trim();
  const pc = (settings.pcs || []).find((item) => item.id === pcId);
  if (!pcId || !pc) {
    return {
      up: false,
      latencyMs: null,
      message: "Set Restart on → Companion PC in Port Watch for this service.",
    };
  }
  if (!String(pc.companionUrl || "").trim()) {
    return {
      up: false,
      latencyMs: null,
      message: `Companion URL missing on "${pc.name || "PC"}".`,
    };
  }

  const live = pcState.get(pcId);
  if (live?.online === false) {
    return {
      up: false,
      latencyMs: null,
      message: `Companion PC offline (${pc.name || pc.host})`,
    };
  }

  const hints = [];
  if (target.id === "fileflows-node") {
    hints.push("FileFlows.Node", "fileflows.node");
  }
  if (target.id === "fileflows") {
    hints.push("FileFlows.Server", "fileflows.server");
  }

  const status = await requestCompanionServiceStatus(
    pc.companionUrl,
    pc.companionApiKey,
    {
      windowsService: serviceCfg.windowsService,
      exePath: serviceCfg.exePath,
      exeArgs: serviceCfg.exeArgs,
      exeCwd: serviceCfg.exeCwd,
      processHints: hints,
    },
  );

  if (!status.ok && status.running !== true) {
    return {
      up: false,
      latencyMs: status.latencyMs,
      message: status.message || "Companion status check failed",
    };
  }

  return {
    up: Boolean(status.running),
    latencyMs: status.latencyMs,
    message:
      status.message ||
      (status.running ? "Running on Companion PC" : "Not running"),
  };
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

  const companionProbe = wantsCompanionProbe(target, serviceCfg);
  const parsed = companionProbe ? null : hostPortFromUrl(target.url);

  let result;
  if (companionProbe) {
    result = await probeViaCompanion(target, serviceCfg, settings);
  } else if (!parsed) {
    state.set(target.id, {
      ...(state.get(target.id) ?? {}),
      up: false,
      latencyMs: null,
      lastChecked: new Date().toISOString(),
      message: "Invalid URL",
    });
    return;
  } else {
    result = await checkPort(parsed.host, parsed.port);
  }

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

  const hasRestartTarget =
    Boolean(String(serviceCfg.windowsService || "").trim()) ||
    Boolean(String(serviceCfg.exePath || "").trim());
  const usesCompanion = Boolean(String(serviceCfg.restartPcId || "").trim());
  const canRestart =
    target.allowRestart !== false &&
    (usesCompanion || target.mode !== "remote") &&
    settings.autoRestart &&
    serviceCfg.autoRestart &&
    hasRestartTarget;

  const locationLabel = companionProbe
    ? "Companion service/process"
    : parsed
      ? `${parsed.host}:${parsed.port}`
      : "unknown";

  if (
    !result.up &&
    !downAlertSent &&
    consecutiveFails >= settings.failThreshold &&
    settings.discordNotifyDown !== false
  ) {
    downAlertSent = true;
    await notifyDiscord(settings, {
      title: `${target.name} is down`,
      description: [
        `Mode: **${target.mode === "remote" ? "Remote" : "Home"}**`,
        companionProbe
          ? `Check: Companion service/process`
          : `Host: \`${locationLabel}\``,
        `Failed checks: **${consecutiveFails}** (threshold ${settings.failThreshold})`,
        `Detail: ${result.message}`,
        canRestart
          ? usesCompanion
            ? "Arrs Hub will ask the Companion app on that PC to restart."
            : "Arrs Hub will try to restart the Windows service."
          : target.mode === "remote"
            ? "Remote status only - restart is Home/Plex-PC only."
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
      const restart = await restartForService(serviceCfg, settings);
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
            companionProbe
              ? "Checked via Companion service status"
              : `Checked port: \`${locationLabel}\``,
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
      description: companionProbe
        ? `${result.message}${
            result.latencyMs != null ? ` (${result.latencyMs} ms)` : ""
          }.`
        : `Port \`${locationLabel}\` is responding again${
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
          ? companionProbe
            ? "Remote · running (Companion)"
            : "Remote port open"
          : result.message || "Remote unreachable"
        : result.up
          ? companionProbe
            ? result.message || "Running (Companion)"
            : result.message || "Port open"
          : result.message,
    downAlertSent,
    mode: target.mode || "home",
  });
}

export async function runWatchCycle() {
  const settings = loadWatchdogSettings();
  const snapshot = [...targets];
  const checked = new Set(snapshot.map((t) => t.id));

  // Also probe companion-only services (e.g. FileFlows Node) if not in UI targets yet.
  for (const [id, cfg] of Object.entries(settings.services || {})) {
    if (checked.has(id)) continue;
    if (!cfg?.monitor || !String(cfg.restartPcId || "").trim()) continue;
    if (id !== "fileflows-node") continue;
    snapshot.push({
      id,
      name: id === "fileflows-node" ? "FileFlows Node" : "FileFlows",
      url: COMPANION_PROBE_URL,
      mode: "home",
      allowRestart: true,
      probe: "companion",
    });
    checked.add(id);
  }

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
    let online = probe.online;
    let method = probe.method;
    let message = probe.message;

    if (String(pc.companionUrl || "").trim()) {
      const companion = await checkCompanionHealth(
        pc.companionUrl,
        pc.companionApiKey,
      );
      if (companion.online) {
        online = true;
        message = `Companion online (${companion.message})`;
        method =
          companion.latencyMs != null
            ? `companion:${companion.latencyMs}ms`
            : "companion";
      } else if (!probe.online) {
        online = false;
        message = companion.message || probe.message || "Offline";
        method = null;
      } else {
        message = `${probe.message}; companion: ${companion.message}`;
      }
    }

    let consecutiveFails = online ? 0 : (prev.consecutiveFails || 0) + 1;
    let lastWakeAt = prev.lastWakeAt ?? null;
    let lastWakeResult = prev.lastWakeResult ?? null;
    let downAlertSent = Boolean(prev.downAlertSent);

    if (online) downAlertSent = false;

    const wasOffline = prev.online === false;
    if (online && wasOffline && settings.discordNotifyRecovered !== false) {
      await notifyDiscord(settings, {
        title: `${pc.name} is back online`,
        description: `Host \`${pc.host}\` responded (${probe.method || "ok"}).`,
        color: DISCORD_COLORS.recovered,
      });
    }

    if (
      !online &&
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
      !online &&
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
      online,
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
