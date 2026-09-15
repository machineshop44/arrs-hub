/**
 * Hub API token for non-localhost callers (Mobile / LAN / WAN on :3000).
 * Photo-dump keeps its own key (X-Arrs-Hub-Key). This token uses X-Arrs-Hub-Token.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, ensureDataDirs } from "./config.mjs";

export const HUB_AUTH_SETTINGS_PATH = path.join(DATA_DIR, "hub-auth-settings.json");

function randomToken() {
  return crypto.randomBytes(24).toString("hex");
}

function maskToken(token) {
  if (!token) return "";
  if (token.length <= 8) return "••••••••";
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

export function defaultHubAuthSettings() {
  return {
    /** Empty until generated — remote callers blocked until set (except public routes). */
    apiToken: "",
    /** When true, require token for non-local. When false, legacy open LAN (not recommended). */
    requireTokenForRemote: true,
  };
}

function atomicWriteJson(filePath, value) {
  ensureDataDirs();
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}

export function loadHubAuthSettings() {
  ensureDataDirs();
  if (!fs.existsSync(HUB_AUTH_SETTINGS_PATH)) {
    const defaults = defaultHubAuthSettings();
    // First run: mint a token so remote is locked once Settings is opened / health reports set.
    defaults.apiToken = randomToken();
    atomicWriteJson(HUB_AUTH_SETTINGS_PATH, defaults);
    return defaults;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(HUB_AUTH_SETTINGS_PATH, "utf8"));
    const defaults = defaultHubAuthSettings();
    return {
      ...defaults,
      ...raw,
      apiToken: typeof raw.apiToken === "string" ? raw.apiToken : "",
      requireTokenForRemote: raw.requireTokenForRemote !== false,
    };
  } catch {
    return defaultHubAuthSettings();
  }
}

export function saveHubAuthSettings(settings) {
  atomicWriteJson(HUB_AUTH_SETTINGS_PATH, settings);
  return settings;
}

export function publicHubAuthSettings(settings = loadHubAuthSettings()) {
  return {
    apiToken: settings.apiToken ? maskToken(settings.apiToken) : "",
    apiTokenSet: Boolean(String(settings.apiToken || "").trim()),
    requireTokenForRemote: settings.requireTokenForRemote !== false,
  };
}

/**
 * @param {Record<string, unknown>} patch
 * @param {{ rotateToken?: boolean }} [opts]
 */
export function updateHubAuthSettings(patch = {}, opts = {}) {
  const current = loadHubAuthSettings();
  let apiToken = current.apiToken;
  if (opts.rotateToken || patch.rotateToken === true) {
    apiToken = randomToken();
  } else if (typeof patch.apiToken === "string") {
    const trimmed = patch.apiToken.trim();
    if (trimmed && !trimmed.includes("…") && !trimmed.includes("•")) {
      apiToken = trimmed;
    }
  }
  const next = {
    apiToken,
    requireTokenForRemote:
      patch.requireTokenForRemote !== undefined
        ? Boolean(patch.requireTokenForRemote)
        : current.requireTokenForRemote !== false,
  };
  return saveHubAuthSettings(next);
}

export function verifyHubApiToken(provided) {
  const settings = loadHubAuthSettings();
  const expected = String(settings.apiToken || "").trim();
  if (!expected) return false;
  const got = String(provided || "").trim();
  if (!got) return false;
  const a = crypto.createHash("sha256").update(got, "utf8").digest();
  const b = crypto.createHash("sha256").update(expected, "utf8").digest();
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function clientRemoteIp(req) {
  const raw = req.socket?.remoteAddress || req.connection?.remoteAddress || "";
  return String(raw).replace(/^::ffff:/i, "");
}

/** Fail-closed: only loopback counts as local (never empty IP). */
export function isLocalHubRequest(req) {
  const ip = clientRemoteIp(req);
  return ip === "127.0.0.1" || ip === "::1";
}

export function readHubApiToken(req) {
  const header = req.headers["x-arrs-hub-token"];
  if (typeof header === "string" && header.trim()) return header.trim();
  const auth = req.headers.authorization;
  if (typeof auth === "string" && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, "").trim();
  }
  // Query param for media players (VLC / libVLC) that cannot set custom headers.
  // Prefer hubToken; accept token as a fallback for older Mobile builds.
  const q = req.query || {};
  const fromQuery =
    (typeof q.hubToken === "string" && q.hubToken.trim()) ||
    (typeof q.token === "string" && q.token.trim()) ||
    "";
  return fromQuery;
}

/**
 * Express middleware: localhost OR valid Hub token.
 * Skip for routes registered before this middleware.
 */
export function requireHubAuth(req, res, next) {
  if (isLocalHubRequest(req)) {
    next();
    return;
  }
  const settings = loadHubAuthSettings();
  if (settings.requireTokenForRemote === false) {
    next();
    return;
  }
  if (!String(settings.apiToken || "").trim()) {
    res.status(503).json({
      error: "Hub API token is not configured. Generate one in Settings (localhost).",
    });
    return;
  }
  if (!verifyHubApiToken(readHubApiToken(req))) {
    res.status(401).json({
      error: "Invalid or missing Hub API token (X-Arrs-Hub-Token).",
    });
    return;
  }
  next();
}
