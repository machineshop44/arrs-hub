import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.ARRS_COMPANION_ROOT
  ? path.resolve(process.env.ARRS_COMPANION_ROOT)
  : path.resolve(__dirname, "..");

export const COMPANION_DATA_DIR = process.env.ARRS_COMPANION_DATA_DIR
  ? path.resolve(process.env.ARRS_COMPANION_DATA_DIR)
  : path.join(ROOT, "data");

export const COMPANION_SETTINGS_PATH = path.join(
  COMPANION_DATA_DIR,
  "companion-settings.json",
);

function ensureDataDirs() {
  fs.mkdirSync(COMPANION_DATA_DIR, { recursive: true });
}

export function defaultCompanionSettings() {
  return {
    companionId: `companion-${crypto.randomBytes(8).toString("hex")}`,
    name: "Downloader PC",
    apiKey: crypto.randomBytes(24).toString("hex"),
    port: 3901,
    bind: "0.0.0.0",
    hubUrl: "",
    autoDiscoverHub: true,
    lastDiscoverAt: null,
    lastDiscoverOk: false,
    lastRegisterAt: null,
    lastRegisterOk: false,
    lastRegisterMessage: "",
  };
}
export function loadCompanionSettings() {
  ensureDataDirs();
  if (!fs.existsSync(COMPANION_SETTINGS_PATH)) {
    const defaults = defaultCompanionSettings();
    saveCompanionSettings(defaults);
    return defaults;
  }
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(COMPANION_SETTINGS_PATH, "utf8"));
    if (!raw || typeof raw !== "object") raw = {};
  } catch (err) {
    console.error(
      "companion-settings.json unreadable — resetting defaults:",
      err instanceof Error ? err.message : err,
    );
    try {
      const bak = `${COMPANION_SETTINGS_PATH}.bad-${Date.now()}`;
      fs.renameSync(COMPANION_SETTINGS_PATH, bak);
    } catch {
      // ignore
    }
    const defaults = defaultCompanionSettings();
    saveCompanionSettings(defaults);
    return defaults;
  }
  const defaults = defaultCompanionSettings();
  return {
    ...defaults,
    ...raw,
    companionId: String(raw.companionId || defaults.companionId),
    apiKey: String(raw.apiKey || defaults.apiKey),
    port: Number(raw.port) || defaults.port,
    bind: String(raw.bind || defaults.bind),
    hubUrl: String(raw.hubUrl || ""),
    autoDiscoverHub: raw.autoDiscoverHub !== false,
    lastRegisterMessage: String(raw.lastRegisterMessage || ""),
  };
}

export function saveCompanionSettings(settings) {
  ensureDataDirs();
  fs.writeFileSync(
    COMPANION_SETTINGS_PATH,
    `${JSON.stringify(settings, null, 2)}\n`,
    "utf8",
  );
  return settings;
}

export function publicCompanionSettings(settings) {
  return {
    companionId: settings.companionId,
    name: settings.name,
    port: settings.port,
    bind: settings.bind,
    apiKeySet: Boolean(settings.apiKey),
    hubUrl: settings.hubUrl || "",
    autoDiscoverHub: settings.autoDiscoverHub !== false,
    lastDiscoverAt: settings.lastDiscoverAt || null,
    lastDiscoverOk: Boolean(settings.lastDiscoverOk),
    lastRegisterAt: settings.lastRegisterAt || null,
    lastRegisterOk: Boolean(settings.lastRegisterOk),
    lastRegisterMessage: settings.lastRegisterMessage || "",
  };
}
export function verifyCompanionApiKey(provided, expected) {
  const a = String(provided || "").trim();
  const b = String(expected || "").trim();
  if (!b) return false;
  if (!a) return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
