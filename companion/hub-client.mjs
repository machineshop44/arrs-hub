import fs from "node:fs";
import {
  loadCompanionSettings,
  saveCompanionSettings,
} from "./companion-store.mjs";
import { pickPrimaryLan, subnetHosts } from "./network.mjs";

const HUB_PORTS = [3000, 3847];
const COMPANION_SERVICE_IDS = ["qbittorrent", "sabnzbd"];
const SERVICE_PORTS = {
  qbittorrent: 8080,
  sabnzbd: 8085,
};
const DEFAULT_WINDOWS_SERVICES = {
  qbittorrent: "qbittorrent",
  sabnzbd: "SABnzbd",
};
const DEFAULT_EXE_PATHS = {
  qbittorrent: "C:\\Program Files\\qBittorrent\\qbittorrent.exe",
  sabnzbd: "C:\\Program Files\\SABnzbd\\SABnzbd.exe",
};

/** @type {ReturnType<typeof setInterval> | null} */
let registerTimer = null;

function normalizeHubUrl(raw) {
  const trimmed = String(raw || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.includes("://") ? trimmed : `http://${trimmed}`;
}

async function probeHub(baseUrl) {
  const url = normalizeHubUrl(baseUrl);
  if (!url) return "";
  try {
    const res = await fetch(`${url}/api/health`, {
      signal: AbortSignal.timeout(500),
    });
    if (!res.ok) return "";
    const data = await res.json();
    if (!data?.ok) return "";
    const product = String(data?.productName || "").toLowerCase();
    const name = String(data?.name || "").toLowerCase();
    if (product.includes("companion")) return "";
    if (product.includes("arrs hub") || name === "arrs-hub") return url;
    return "";
  } catch {
    return "";
  }
}

/**
 * Scan the LAN for an Arrs Hub instance (once when hubUrl is not configured).
 */
export async function discoverHubUrl() {
  for (const host of ["127.0.0.1", "localhost"]) {
    for (const port of HUB_PORTS) {
      const hit = await probeHub(`http://${host}:${port}`);
      if (hit) return hit;
    }
  }

  const primary = pickPrimaryLan();
  if (!primary) return "";

  const hosts = subnetHosts(primary.address);
  const urls = hosts.map((host) => `http://${host}:3000`);

  for (let i = 0; i < urls.length; i += 40) {
    const batch = urls.slice(i, i + 40);
    const results = await Promise.all(batch.map((url) => probeHub(url)));
    const hit = results.find(Boolean);
    if (hit) return hit;
  }

  return "";
}

function buildRegistrationPayload(settings) {
  const primary = pickPrimaryLan();
  const host = primary?.address || "127.0.0.1";
  const mac = primary?.mac || "";
  const exeDefaults = DEFAULT_EXE_PATHS;

  const services = COMPANION_SERVICE_IDS.map((id) => ({
    id,
    windowsService: DEFAULT_WINDOWS_SERVICES[id] || "",
    exePath: exeDefaults[id] || "",
    port: SERVICE_PORTS[id],
  }));

  return {
    companionId: settings.companionId,
    name: settings.name,
    host,
    mac,
    port: settings.port,
    apiKey: settings.apiKey,
    services,
  };
}

/**
 * @param {string} hubUrl
 * @param {ReturnType<typeof loadCompanionSettings>} settings
 */
export async function registerWithHub(hubUrl, settings) {
  const base = normalizeHubUrl(hubUrl);
  if (!base) {
    return { ok: false, message: "No Arrs Hub URL configured." };
  }

  const payload = buildRegistrationPayload(settings);
  try {
    const res = await fetch(`${base}/api/watchdog/companion-register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(12000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        message: data?.error || `Hub registration HTTP ${res.status}`,
      };
    }
    return {
      ok: Boolean(data?.ok),
      message: data?.message || "Registered with Arrs Hub",
      hubUrl: base,
      pcId: data?.pcId,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runHubRegistration() {
  const settings = loadCompanionSettings();
  let hubUrl = normalizeHubUrl(settings.hubUrl);

  if (!hubUrl && settings.autoDiscoverHub !== false) {
    const discovered = await discoverHubUrl();
    if (discovered) {
      hubUrl = discovered;
      saveCompanionSettings({
        ...settings,
        hubUrl: discovered,
        lastDiscoverAt: new Date().toISOString(),
        lastDiscoverOk: true,
      });
    } else {
      saveCompanionSettings({
        ...settings,
        lastDiscoverAt: new Date().toISOString(),
        lastDiscoverOk: false,
      });
      return {
        ok: false,
        message: "Arrs Hub not found on LAN. Set hub URL in tray menu.",
      };
    }
  }

  if (!hubUrl) {
    return { ok: false, message: "Set Arrs Hub URL in tray menu." };
  }

  const current = loadCompanionSettings();
  const result = await registerWithHub(hubUrl, current);
  saveCompanionSettings({
    ...loadCompanionSettings(),
    hubUrl,
    lastRegisterAt: new Date().toISOString(),
    lastRegisterOk: result.ok,
    lastRegisterMessage: result.message,
  });
  return result;
}

export function startHubRegistrationLoop() {
  if (registerTimer) return;
  void runHubRegistration();
  registerTimer = setInterval(() => {
    void runHubRegistration();
  }, 60_000);
}

export function stopHubRegistrationLoop() {
  if (registerTimer) {
    clearInterval(registerTimer);
    registerTimer = null;
  }
}

/** Tray / setup: which downloader apps exist on this PC. */
export function listLocalDownloaderApps() {
  const exeDefaults = DEFAULT_EXE_PATHS;
  return COMPANION_SERVICE_IDS.map((id) => ({
    id,
    exePath: exeDefaults[id] || "",
    installed: Boolean(exeDefaults[id] && fs.existsSync(exeDefaults[id])),
    port: SERVICE_PORTS[id],
  }));
}
