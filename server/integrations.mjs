import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, ensureDataDirs } from "./config.mjs";

export const INTEGRATIONS_PATH = path.join(DATA_DIR, "integrations-settings.json");

export function defaultIntegrationsSettings() {
  return {
    qbittorrent: {
      baseUrl: "http://localhost:8080",
      username: "",
      password: "",
    },
    sabnzbd: {
      baseUrl: "http://localhost:8085",
      apiKey: "",
    },
    ombi: {
      baseUrl: "http://localhost:3579",
      apiKey: "",
    },
  };
}

function pickSecret(incoming, current) {
  if (typeof incoming !== "string") return current;
  const trimmed = incoming.trim();
  if (!trimmed) return current;
  if (trimmed.includes("…") || trimmed.includes("•")) return current;
  return trimmed;
}

function maskKey(key) {
  if (!key) return "";
  if (key.length <= 8) return "••••••••";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export function loadIntegrationsSettings() {
  ensureDataDirs();
  if (!fs.existsSync(INTEGRATIONS_PATH)) {
    const defaults = defaultIntegrationsSettings();
    saveIntegrationsSettings(defaults);
    return defaults;
  }
  const raw = JSON.parse(fs.readFileSync(INTEGRATIONS_PATH, "utf8"));
  const defaults = defaultIntegrationsSettings();
  return {
    qbittorrent: {
      ...defaults.qbittorrent,
      ...(raw.qbittorrent ?? {}),
    },
    sabnzbd: {
      ...defaults.sabnzbd,
      ...(raw.sabnzbd ?? {}),
    },
    ombi: {
      ...defaults.ombi,
      ...(raw.ombi ?? {}),
    },
  };
}

export function saveIntegrationsSettings(settings) {
  ensureDataDirs();
  fs.writeFileSync(
    INTEGRATIONS_PATH,
    `${JSON.stringify(settings, null, 2)}\n`,
    "utf8",
  );
  return settings;
}

export function updateIntegrationsSettings(patch = {}) {
  const current = loadIntegrationsSettings();
  const next = {
    qbittorrent: {
      baseUrl:
        patch.qbittorrent?.baseUrl !== undefined
          ? String(patch.qbittorrent.baseUrl || "").trim() ||
            current.qbittorrent.baseUrl
          : current.qbittorrent.baseUrl,
      username:
        patch.qbittorrent?.username !== undefined
          ? String(patch.qbittorrent.username || "")
          : current.qbittorrent.username,
      password: pickSecret(
        patch.qbittorrent?.password,
        current.qbittorrent.password,
      ),
    },
    sabnzbd: {
      baseUrl:
        patch.sabnzbd?.baseUrl !== undefined
          ? String(patch.sabnzbd.baseUrl || "").trim() || current.sabnzbd.baseUrl
          : current.sabnzbd.baseUrl,
      apiKey: pickSecret(patch.sabnzbd?.apiKey, current.sabnzbd.apiKey),
    },
    ombi: {
      baseUrl:
        patch.ombi?.baseUrl !== undefined
          ? String(patch.ombi.baseUrl || "").trim() || current.ombi.baseUrl
          : current.ombi.baseUrl,
      apiKey: pickSecret(patch.ombi?.apiKey, current.ombi.apiKey),
    },
  };
  return saveIntegrationsSettings(next);
}

export function publicIntegrationsSettings(
  settings = loadIntegrationsSettings(),
) {
  return {
    qbittorrent: {
      baseUrl: settings.qbittorrent.baseUrl,
      username: settings.qbittorrent.username || "",
      password: settings.qbittorrent.password ? "••••••••" : "",
      passwordSet: Boolean(settings.qbittorrent.password),
    },
    sabnzbd: {
      baseUrl: settings.sabnzbd.baseUrl,
      apiKey: settings.sabnzbd.apiKey ? maskKey(settings.sabnzbd.apiKey) : "",
      apiKeySet: Boolean(settings.sabnzbd.apiKey),
    },
    ombi: {
      baseUrl: settings.ombi.baseUrl,
      apiKey: settings.ombi.apiKey ? maskKey(settings.ombi.apiKey) : "",
      apiKeySet: Boolean(settings.ombi.apiKey),
    },
  };
}
