import {
  DEFAULT_WINDOWS_SERVICES,
  loadWatchdogSettings,
  saveWatchdogSettings,
} from "./watchdog-store.mjs";
import { normalizeMac } from "./wol.mjs";
import {
  loadIntegrationsSettings,
  updateIntegrationsSettings,
} from "./integrations.mjs";
import { restartWatchLoop } from "./watchdog.mjs";

const COMPANION_SERVICE_IDS = ["qbittorrent", "sabnzbd"];

function isLocalServiceUrl(url) {
  try {
    const withProto = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)
      ? url
      : `http://${url}`;
    const hostname = new URL(withProto).hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1"
    );
  } catch {
    return true;
  }
}

function serviceHomeUrl(host, port) {
  return `http://${host}:${port}`;
}

/**
 * Companion tray app registers itself so Port Watch can restart qBit/SAB remotely.
 * @param {object} payload
 */
export function registerCompanionPeer(payload) {
  const companionId = String(payload?.companionId || "").trim();
  if (!companionId) {
    throw new Error("companionId is required.");
  }

  const host = String(payload?.host || "").trim();
  if (!host) {
    throw new Error("host (LAN IP) is required.");
  }

  const port = Number(payload?.port) || 3901;
  const apiKey = String(payload?.apiKey || "").trim();
  if (!apiKey) {
    throw new Error("apiKey is required.");
  }

  const settings = loadWatchdogSettings();
  const pcs = Array.isArray(settings.pcs) ? [...settings.pcs] : [];
  const pc = pcs.find((item) => item.companionId === companionId);
  const pcId =
    pc?.id ||
    `companion-${companionId.replace(/^companion-/, "").slice(0, 24)}`;

  const companionUrl = `http://${host}:${port}`;
  const nextPc = {
    id: pcId,
    name: String(payload?.name || "Downloader PC").trim() || "Downloader PC",
    host,
    mac: normalizeMac(payload?.mac) || String(payload?.mac || "").trim(),
    monitor: true,
    wakeOnLan: true,
    companionUrl,
    companionApiKey: apiKey,
    companionId,
    lastRegisterAt: new Date().toISOString(),
  };

  if (pc) {
    const idx = pcs.findIndex((item) => item.id === pc.id);
    pcs[idx] = { ...pc, ...nextPc, companionApiKey: apiKey };
  } else {
    pcs.push(nextPc);
  }

  const services = { ...settings.services };
  const urlHints = { ...(settings.companionUrlHints || {}) };
  const serviceList = Array.isArray(payload?.services) ? payload.services : [];

  for (const svc of serviceList) {
    const id = String(svc?.id || "").trim();
    if (!COMPANION_SERVICE_IDS.includes(id)) continue;

    const base = services[id] ?? {
      monitor: true,
      autoRestart: true,
      windowsService: DEFAULT_WINDOWS_SERVICES[id] || "",
      exePath: "",
      exeArgs: "",
      exeCwd: "",
      restartPcId: "",
    };

    const svcPort = Number(svc?.port) || (id === "qbittorrent" ? 8080 : 8085);
    const hintedUrl = serviceHomeUrl(host, svcPort);

    services[id] = {
      ...base,
      monitor: true,
      autoRestart: true,
      restartPcId: pcId,
      windowsService:
        String(svc?.windowsService || "").trim() ||
        base.windowsService ||
        DEFAULT_WINDOWS_SERVICES[id] ||
        "",
      exePath: String(svc?.exePath || "").trim() || base.exePath || "",
    };
    urlHints[id] = hintedUrl;
  }

  const integrations = loadIntegrationsSettings();
  const integrationsPatch = {};
  for (const id of COMPANION_SERVICE_IDS) {
    const hint = urlHints[id];
    if (!hint) continue;
    const currentUrl = integrations[id]?.baseUrl || "";
    if (isLocalServiceUrl(currentUrl)) {
      integrationsPatch[id] = { baseUrl: hint };
    }
  }

  if (Object.keys(integrationsPatch).length > 0) {
    updateIntegrationsSettings(integrationsPatch);
  }

  const next = {
    ...settings,
    pcs,
    services,
    companionUrlHints: urlHints,
  };
  saveWatchdogSettings(next);
  restartWatchLoop();

  return {
    ok: true,
    pcId,
    companionUrl,
    message: `Registered ${nextPc.name} — qBit/SAB restarts will use Companion.`,
    urlHints,
  };
}

export function getCompanionUrlHints() {
  const settings = loadWatchdogSettings();
  return settings.companionUrlHints || {};
}
