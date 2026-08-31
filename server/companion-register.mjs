import {
  DEFAULT_WINDOWS_SERVICES,
  loadWatchdogSettings,
  saveWatchdogSettings,
} from "./watchdog-store.mjs";
import { normalizeMac } from "./wol.mjs";
import {
  isLikelyVirtualIp,
  isLikelyVirtualMac,
  isLikelyVirtualPc,
} from "./lan-utils.mjs";
import {
  loadIntegrationsSettings,
  updateIntegrationsSettings,
} from "./integrations.mjs";
import { restartWatchLoop } from "./watchdog.mjs";

const COMPANION_SERVICE_IDS = [
  "qbittorrent",
  "sabnzbd",
  "fileflows",
  "fileflows-node",
];

const DEFAULT_SERVICE_PORTS = {
  qbittorrent: 8080,
  sabnzbd: 8085,
  fileflows: 19200,
  "fileflows-node": 19200,
};

/** Integrations only track download clients — not FileFlows. */
const INTEGRATION_SERVICE_IDS = ["qbittorrent", "sabnzbd"];

/** Only overwrite dashboard URL hints for these (FileFlows server UI stays on Plex). */
const URL_HINT_SERVICE_IDS = ["qbittorrent", "sabnzbd", "fileflows"];

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

function companionUrlHost(companionUrl) {
  try {
    const withProto = companionUrl.includes("://")
      ? companionUrl
      : `http://${companionUrl}`;
    return new URL(withProto).hostname;
  } catch {
    return "";
  }
}

function findExistingPcIndex(pcs, payload, companionUrl) {
  const companionId = String(payload?.companionId || "").trim();
  const host = String(payload?.host || "").trim();
  const port = Number(payload?.port) || 3901;
  const mac = normalizeMac(payload?.mac) || "";

  let idx = pcs.findIndex((item) => item.companionId === companionId);
  if (idx >= 0) return idx;

  idx = pcs.findIndex((item) => {
    const url = String(item.companionUrl || "").trim();
    if (!url) return false;
    try {
      const u = new URL(url.includes("://") ? url : `http://${url}`);
      return u.hostname === host && Number(u.port || 3901) === port;
    } catch {
      return url === companionUrl;
    }
  });
  if (idx >= 0) return idx;

  if (host && !isLikelyVirtualIp(host)) {
    idx = pcs.findIndex(
      (item) =>
        item.host === host &&
        String(item.companionUrl || "").trim() &&
        !isLikelyVirtualPc(item.host, item.mac),
    );
    if (idx >= 0) return idx;
  }

  if (mac && !isLikelyVirtualMac(mac)) {
    idx = pcs.findIndex(
      (item) => normalizeMac(item.mac) === mac && !isLikelyVirtualMac(item.mac),
    );
    if (idx >= 0) return idx;
  }

  return -1;
}

function pruneVirtualDuplicatePcs(pcs, keepPcId) {
  const kept = pcs.find((pc) => pc.id === keepPcId);
  if (!kept || isLikelyVirtualPc(kept.host, kept.mac)) return pcs;

  return pcs.filter((pc) => {
    if (pc.id === keepPcId) return true;
    if (!isLikelyVirtualPc(pc.host, pc.mac)) return true;
    const sameCompanion =
      (kept.companionId && pc.companionId === kept.companionId) ||
      (kept.companionUrl &&
        pc.companionUrl &&
        companionUrlHost(pc.companionUrl) ===
          companionUrlHost(kept.companionUrl));
    return !sameCompanion;
  });
}

function pickPcName(existing, payloadName) {
  const incoming = String(payloadName || "Downloader PC").trim() || "Downloader PC";
  const prev = String(existing?.name || "").trim();
  if (prev && prev !== "Downloader PC" && incoming === "Downloader PC") {
    return prev;
  }
  return incoming;
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
  if (isLikelyVirtualIp(host)) {
    throw new Error(
      `Refusing virtual adapter IP ${host}. Set Hub URL manually or disable VirtualBox Host-Only.`,
    );
  }

  const port = Number(payload?.port) || 3901;
  const apiKey = String(payload?.apiKey || "").trim();
  if (!apiKey) {
    throw new Error("apiKey is required.");
  }

  const mac = normalizeMac(payload?.mac) || String(payload?.mac || "").trim();
  if (isLikelyVirtualMac(mac)) {
    throw new Error(
      "Refusing virtual NIC MAC from companion registration (VirtualBox/Hyper-V).",
    );
  }

  const settings = loadWatchdogSettings();
  let pcs = Array.isArray(settings.pcs) ? [...settings.pcs] : [];
  const companionUrl = `http://${host}:${port}`;
  const existingIdx = findExistingPcIndex(pcs, payload, companionUrl);
  const existing = existingIdx >= 0 ? pcs[existingIdx] : null;
  const pcId =
    existing?.id ||
    `companion-${companionId.replace(/^companion-/, "").slice(0, 24)}`;

  const nextPc = {
    id: pcId,
    name: pickPcName(existing, payload?.name),
    host,
    mac,
    monitor: true,
    wakeOnLan: true,
    companionUrl,
    companionApiKey: apiKey,
    companionId,
    lastRegisterAt: new Date().toISOString(),
  };

  if (existingIdx >= 0) {
    pcs[existingIdx] = { ...existing, ...nextPc, companionApiKey: apiKey };
  } else {
    pcs.push(nextPc);
  }

  pcs = pruneVirtualDuplicatePcs(pcs, pcId);

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

    const svcPort =
      Number(svc?.port) || DEFAULT_SERVICE_PORTS[id] || 0;
    const role = String(svc?.role || "").toLowerCase();
    const prevRestartPc = base.restartPcId || "";
    const prevPc = pcs.find((item) => item.id === prevRestartPc);
    const shouldRewire =
      !prevRestartPc ||
      prevRestartPc === pcId ||
      isLikelyVirtualPc(prevPc?.host, prevPc?.mac);

    services[id] = {
      ...base,
      monitor: true,
      autoRestart: true,
      restartPcId: shouldRewire ? pcId : prevRestartPc,
      windowsService:
        String(svc?.windowsService || "").trim() ||
        base.windowsService ||
        DEFAULT_WINDOWS_SERVICES[id] ||
        "",
      exePath: String(svc?.exePath || "").trim() || base.exePath || "",
      exeArgs: String(svc?.exeArgs || "").trim() || base.exeArgs || "",
      exeCwd: String(svc?.exeCwd || "").trim() || base.exeCwd || "",
    };

    // FileFlows Node has no stable public UI — do not steal the FileFlows tile URL.
    // FileFlows Server on companion may update the hint when role=server.
    if (
      URL_HINT_SERVICE_IDS.includes(id) &&
      svcPort > 0 &&
      (id !== "fileflows" || role === "server" || !role)
    ) {
      urlHints[id] = serviceHomeUrl(host, svcPort);
    }
  }

  const integrations = loadIntegrationsSettings();
  const integrationsPatch = {};
  for (const id of INTEGRATION_SERVICE_IDS) {
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

  const merged = existingIdx >= 0;
  const hasFileFlows = serviceList.some((s) =>
    String(s?.id || "").startsWith("fileflows"),
  );
  const restartBits = hasFileFlows
    ? "qBit/SAB/FileFlows restarts will use Companion."
    : "qBit/SAB restarts will use Companion.";
  return {
    ok: true,
    pcId,
    companionUrl,
    merged,
    message: merged
      ? `Updated ${nextPc.name} — ${restartBits}`
      : `Registered ${nextPc.name} — ${restartBits}`,
    urlHints,
  };
}

export function getCompanionUrlHints() {
  const settings = loadWatchdogSettings();
  return settings.companionUrlHints || {};
}
