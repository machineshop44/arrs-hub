import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, ensureDataDirs } from "./config.mjs";

export const TAUTULLI_SETTINGS_PATH = path.join(
  DATA_DIR,
  "tautulli-settings.json",
);

export function defaultTautulliSettings() {
  return {
    baseUrl: "http://localhost:8181",
    apiKey: "",
  };
}

export function normalizeTautulliBaseUrl(url) {
  let value = String(url || "").trim();
  if (!value) return "http://localhost:8181";
  value = value.replace(/\/home\/?$/i, "");
  value = value.replace(/\/$/, "");
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  return value;
}

export function loadTautulliSettings() {
  ensureDataDirs();
  if (!fs.existsSync(TAUTULLI_SETTINGS_PATH)) {
    const defaults = defaultTautulliSettings();
    saveTautulliSettings(defaults);
    return defaults;
  }
  const raw = fs
    .readFileSync(TAUTULLI_SETTINGS_PATH, "utf8")
    .replace(/^\uFEFF/, "")
    .trim();
  const start = raw.indexOf("{");
  const jsonText = start >= 0 ? raw.slice(start) : raw;
  const parsed = JSON.parse(jsonText);
  return {
    ...defaultTautulliSettings(),
    ...parsed,
    baseUrl: normalizeTautulliBaseUrl(
      parsed.baseUrl || defaultTautulliSettings().baseUrl,
    ),
    apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
  };
}

export function saveTautulliSettings(settings) {
  ensureDataDirs();
  const next = {
    baseUrl: normalizeTautulliBaseUrl(settings.baseUrl),
    apiKey: typeof settings.apiKey === "string" ? settings.apiKey.trim() : "",
  };
  fs.writeFileSync(
    TAUTULLI_SETTINGS_PATH,
    `${JSON.stringify(next, null, 2)}\n`,
    "utf8",
  );
  return next;
}

function maskKey(key) {
  if (!key) return "";
  if (key.length <= 8) return "••••••••";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export function pickApiKey(incoming, current) {
  if (typeof incoming !== "string") return current;
  const trimmed = incoming.trim();
  if (!trimmed) return current;
  if (trimmed.includes("…") || trimmed.includes("•")) return current;
  return trimmed;
}

export function publicTautulliSettings(settings = loadTautulliSettings()) {
  const apiKey = settings.apiKey?.trim() || "";
  return {
    baseUrl: normalizeTautulliBaseUrl(settings.baseUrl),
    apiKey: apiKey ? maskKey(apiKey) : "",
    apiKeySet: Boolean(apiKey),
  };
}

export function updateTautulliSettings(patch = {}) {
  const current = loadTautulliSettings();
  const next = saveTautulliSettings({
    baseUrl:
      patch.baseUrl === undefined ? current.baseUrl : patch.baseUrl,
    apiKey: pickApiKey(patch.apiKey, current.apiKey),
  });
  return next;
}

function requireConfigured() {
  const settings = loadTautulliSettings();
  const baseUrl = normalizeTautulliBaseUrl(settings.baseUrl);
  const apiKey = settings.apiKey?.trim() || "";
  if (!apiKey) {
    const err = new Error(
      "Tautulli API key not set. Add it in hub Settings → Tautulli or Streams → Setup (Tautulli → Settings → Web Interface → API).",
    );
    err.code = "TAUTULLI_NOT_CONFIGURED";
    throw err;
  }
  return { baseUrl, apiKey };
}

/**
 * Call Tautulli API v2 and return parsed JSON.
 * @param {string} cmd
 * @param {Record<string, string|number|boolean|undefined|null>} [params]
 */
export async function tautulliApi(cmd, params = {}) {
  const { baseUrl, apiKey } = requireConfigured();
  const url = new URL(`${baseUrl}/api/v2`);
  url.searchParams.set("apikey", apiKey);
  url.searchParams.set("cmd", cmd);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }

  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    throw new Error(
      `Tautulli ${cmd} failed: HTTP ${res.status}${text ? ` — ${text.slice(0, 200)}` : ""}`,
    );
  }

  const result = json?.response?.result;
  if (result && result !== "success") {
    throw new Error(
      json?.response?.message || `Tautulli ${cmd} returned ${result}`,
    );
  }

  return json?.response?.data ?? json?.response ?? json;
}

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pickThumb(session) {
  const mediaType = String(session.media_type || "").toLowerCase();
  if (mediaType === "episode") {
    return (
      session.grandparent_thumb ||
      session.parent_thumb ||
      session.thumb ||
      ""
    );
  }
  return session.thumb || session.grandparent_thumb || session.parent_thumb || "";
}

function formatDecision(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "Unknown";
  if (raw === "direct play") return "Direct Play";
  if (raw === "direct stream" || raw === "copy") return "Direct Stream";
  if (raw === "transcode") return "Transcode";
  return raw.replace(/\b\w/g, (c) => c.toUpperCase());
}

function mapSession(session) {
  const thumb = pickThumb(session);
  const ratingKey =
    session.rating_key ||
    session.grandparent_rating_key ||
    session.parent_rating_key ||
    "";
  const progressPercent = asNumber(session.progress_percent, 0);
  const viewOffset = asNumber(session.view_offset, 0);
  const duration = asNumber(session.duration, 0);
  const bandwidth = asNumber(
    session.bandwidth ?? session.stream_bitrate ?? session.bitrate,
    0,
  );

  return {
    sessionKey: String(session.session_key ?? session.session_id ?? ""),
    state: String(session.state || "playing").toLowerCase(),
    mediaType: String(session.media_type || ""),
    title: String(session.title || ""),
    fullTitle: String(session.full_title || session.title || "Unknown"),
    grandparentTitle: String(session.grandparent_title || ""),
    parentTitle: String(session.parent_title || ""),
    year: session.year ? String(session.year) : "",
    user: String(session.friendly_name || session.user || "Unknown"),
    username: String(session.user || ""),
    player: String(session.player || ""),
    product: String(session.product || ""),
    platform: String(session.platform || ""),
    device: String(session.device || ""),
    location: String(session.location || ""),
    qualityProfile: String(session.quality_profile || session.stream_video_full_resolution || ""),
    videoResolution: String(
      session.stream_video_full_resolution ||
        session.video_full_resolution ||
        "",
    ),
    streamContainer: String(session.stream_container || session.container || ""),
    videoDecision: formatDecision(session.video_decision || session.transcode_decision),
    audioDecision: formatDecision(session.audio_decision || ""),
    transcodeDecision: formatDecision(session.transcode_decision),
    progressPercent: Math.max(0, Math.min(100, progressPercent)),
    viewOffset,
    duration,
    bandwidth,
    streamBitrate: asNumber(session.stream_bitrate, 0),
    thumb,
    ratingKey: ratingKey ? String(ratingKey) : "",
    libraryName: String(session.library_name || ""),
  };
}

/**
 * Normalize get_activity for the Streams UI.
 */
export async function getTautulliActivity() {
  const data = await tautulliApi("get_activity");
  const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
  return {
    streamCount: asNumber(data?.stream_count, sessions.length),
    streamCountDirectPlay: asNumber(data?.stream_count_direct_play, 0),
    streamCountDirectStream: asNumber(data?.stream_count_direct_stream, 0),
    streamCountTranscode: asNumber(data?.stream_count_transcode, 0),
    totalBandwidth: asNumber(data?.total_bandwidth, 0),
    lanBandwidth: asNumber(data?.lan_bandwidth, 0),
    wanBandwidth: asNumber(data?.wan_bandwidth, 0),
    sessions: sessions.map(mapSession),
  };
}

/**
 * Proxy a PMS image through Tautulli (binary response).
 * @param {{ img?: string, ratingKey?: string, width?: string|number, height?: string|number, fallback?: string }} opts
 */
export async function proxyTautulliImage(opts = {}) {
  const { baseUrl, apiKey } = requireConfigured();
  const url = new URL(`${baseUrl}/api/v2`);
  url.searchParams.set("apikey", apiKey);
  url.searchParams.set("cmd", "pms_image_proxy");

  if (opts.img) url.searchParams.set("img", String(opts.img));
  if (opts.ratingKey) url.searchParams.set("rating_key", String(opts.ratingKey));
  url.searchParams.set("width", String(opts.width || 300));
  url.searchParams.set("height", String(opts.height || 450));
  if (opts.fallback) url.searchParams.set("fallback", String(opts.fallback));

  if (!opts.img && !opts.ratingKey) {
    throw new Error("Image proxy requires img or rating_key");
  }

  const res = await fetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) {
    throw new Error(`Tautulli image proxy failed: HTTP ${res.status}`);
  }

  const contentType = res.headers.get("content-type") || "image/jpeg";
  const buffer = Buffer.from(await res.arrayBuffer());
  return { contentType, buffer };
}
