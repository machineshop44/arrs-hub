import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, ensureDataDirs } from "./config.mjs";
import {
  loadWorkoutSettings,
  normalizePlexBaseUrl,
  saveWorkoutSettings,
} from "./workout-store.mjs";

const PLEX_PRODUCT = "Arrs Hub";
const CLIENT_ID_PATH = path.join(DATA_DIR, "plex-client-id");
/** Stable id for media proxy / transcode (OAuth client id can 503 part downloads). */
const PLEX_MEDIA_CLIENT_ID = "arrs-hub-media";


/** @type {Map<string, { code: string, expiresAt: number }>} */
const pendingPins = new Map();

/**
 * Stable client id for plex.tv OAuth + local PMS calls (persisted in data/).
 */
export function getPlexClientId() {
  ensureDataDirs();
  if (fs.existsSync(CLIENT_ID_PATH)) {
    const existing = fs.readFileSync(CLIENT_ID_PATH, "utf8").trim();
    if (existing) return existing;
  }
  const id = crypto.randomUUID();
  fs.writeFileSync(CLIENT_ID_PATH, `${id}\n`, "utf8");
  return id;
}

function plexHeaders(extra = {}) {
  return {
    Accept: "application/json",
    "X-Plex-Product": PLEX_PRODUCT,
    "X-Plex-Client-Identifier": getPlexClientId(),
    "X-Plex-Device-Name": PLEX_PRODUCT,
    "X-Plex-Platform": "Windows",
    "X-Plex-Device": "PC",
    ...extra,
  };
}

/**
 * @param {string} baseUrl
 * @param {string} token
 * @param {string} apiPath
 * @param {{ method?: string, query?: Record<string, string|number|boolean|undefined|null>, headers?: Record<string,string> }} [options]
 */
async function plexFetch(baseUrl, token, apiPath, options = {}) {
  const url = new URL(apiPath, `${normalizePlexBaseUrl(baseUrl)}/`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  if (token) url.searchParams.set("X-Plex-Token", token);

  const res = await fetch(url, {
    method: options.method || "GET",
    headers: {
      ...plexHeaders({
        "X-Plex-Token": token,
        ...(options.headers ?? {}),
      }),
    },
    signal: AbortSignal.timeout(20000),
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    const detail =
      json?.error ||
      json?.message ||
      text.slice(0, 240) ||
      `HTTP ${res.status}`;
    throw new Error(`Plex ${apiPath} failed: ${detail}`);
  }

  return json;
}

function mediaContainer(json) {
  return json?.MediaContainer ?? json ?? {};
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export function getWorkoutConfig() {
  const settings = loadWorkoutSettings();
  return {
    ...settings,
    plexBaseUrl: normalizePlexBaseUrl(settings.plexBaseUrl),
  };
}

/** Public workout settings shape (token masked). */
export function publicWorkoutSettings(settings = getWorkoutConfig()) {
  const token = settings.plexToken?.trim() || "";
  return {
    ...settings,
    plexToken: token ? maskSecret(token) : "",
    plexTokenSet: Boolean(token),
    plexUsername: settings.plexUsername || "",
  };
}

function maskSecret(key) {
  if (!key) return "";
  if (key.length <= 8) return "••••••••";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export function updateWorkoutConfig(patch = {}) {
  const current = loadWorkoutSettings();
  const next = {
    ...current,
    ...patch,
    plexBaseUrl: normalizePlexBaseUrl(
      patch.plexBaseUrl ?? current.plexBaseUrl,
    ),
  };
  if (
    typeof patch.plexToken === "string" &&
    (patch.plexToken.includes("…") || patch.plexToken.includes("•"))
  ) {
    next.plexToken = current.plexToken;
  }
  saveWorkoutSettings(next);
  return next;
}

/**
 * Start Plex PIN / OAuth login. Returns auth URL for the user to open.
 */
export async function startPlexLogin() {
  const clientId = getPlexClientId();
  const url = new URL("https://plex.tv/api/v2/pins");
  url.searchParams.set("strong", "true");

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: plexHeaders(),
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    const detail = err?.cause?.message || err?.message || String(err);
    throw new Error(`Could not reach plex.tv to start login (${detail}).`);
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    throw new Error(
      json?.error || json?.message || text.slice(0, 240) || `HTTP ${res.status}`,
    );
  }

  const pinId = String(json?.id ?? "");
  const code = String(json?.code ?? "");
  if (!pinId || !code) {
    throw new Error("Plex did not return a login PIN.");
  }

  const expiresIn = Number(json?.expiresIn) || 1800;
  pendingPins.set(pinId, {
    code,
    expiresAt: Date.now() + expiresIn * 1000,
  });

  const params = new URLSearchParams({
    clientID: clientId,
    code,
    "context[device][product]": PLEX_PRODUCT,
  });
  const authUrl = `https://app.plex.tv/auth#?${params.toString()}`;

  return {
    pinId,
    authUrl,
    expiresIn,
  };
}

/**
 * Poll a pending PIN. When authorized, persist the token server-side.
 */
export async function pollPlexLogin(pinId) {
  const id = String(pinId || "").trim();
  if (!id) throw new Error("Missing login PIN id.");

  const pending = pendingPins.get(id);
  if (!pending) {
    throw new Error("Login session expired. Click Sign in with Plex again.");
  }
  if (Date.now() > pending.expiresAt) {
    pendingPins.delete(id);
    throw new Error("Login PIN expired. Click Sign in with Plex again.");
  }

  const url = new URL(`https://plex.tv/api/v2/pins/${encodeURIComponent(id)}`);
  url.searchParams.set("code", pending.code);

  const res = await fetch(url, {
    method: "GET",
    headers: plexHeaders(),
    signal: AbortSignal.timeout(20000),
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
      json?.error || json?.message || text.slice(0, 240) || `HTTP ${res.status}`,
    );
  }

  const authToken = json?.authToken;
  if (!authToken) {
    return {
      ok: false,
      pending: true,
      authenticated: false,
    };
  }

  pendingPins.delete(id);
  const user = await fetchPlexAccount(authToken).catch(() => null);
  updateWorkoutConfig({
    plexToken: authToken,
    plexUsername: user?.username || user?.title || "",
  });

  return {
    ok: true,
    pending: false,
    authenticated: true,
    username: user?.username || user?.title || "",
    settings: publicWorkoutSettings(),
  };
}

export async function logoutPlex() {
  pendingPins.clear();
  updateWorkoutConfig({ plexToken: "", plexUsername: "" });
  return { ok: true, settings: publicWorkoutSettings() };
}

export async function getPlexAuthStatus() {
  const settings = getWorkoutConfig();
  const token = settings.plexToken?.trim() || "";
  if (!token) {
    return {
      authenticated: false,
      plexTokenSet: false,
      username: "",
      plexToken: "",
    };
  }

  let username = settings.plexUsername || "";
  try {
    const user = await fetchPlexAccount(token);
    username = user?.username || user?.title || username;
    if (username && username !== settings.plexUsername) {
      updateWorkoutConfig({ plexUsername: username });
    }
  } catch {
    // Token may still work against local PMS even if plex.tv is unreachable
  }

  return {
    authenticated: true,
    plexTokenSet: true,
    username,
    plexToken: maskSecret(token),
  };
}

async function fetchPlexAccount(token) {
  const res = await fetch("https://plex.tv/api/v2/user", {
    headers: plexHeaders({ "X-Plex-Token": token }),
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
      json?.error || json?.message || text.slice(0, 240) || `HTTP ${res.status}`,
    );
  }
  return json;
}

export async function testPlexConnection(settings = getWorkoutConfig()) {
  if (!settings.plexToken?.trim()) {
    throw new Error("Sign in with Plex first.");
  }
  const json = await plexFetch(
    settings.plexBaseUrl,
    settings.plexToken.trim(),
    "/identity",
  );
  const container = mediaContainer(json);
  return {
    ok: true,
    machineIdentifier: container.machineIdentifier,
    version: container.version,
  };
}

export async function listLibraries(settings = getWorkoutConfig()) {
  requireToken(settings);
  const json = await plexFetch(
    settings.plexBaseUrl,
    settings.plexToken.trim(),
    "/library/sections",
  );
  const container = mediaContainer(json);
  return asArray(container.Directory).map((dir) => ({
    id: String(dir.key),
    title: dir.title,
    type: dir.type,
    agent: dir.agent,
  }));
}

export const LOCAL_CLIENT_ID = "arrs-hub-local";

/**
 * Classify a playback target for UI badges / remote filtering.
 * @param {{ name?: string, product?: string, deviceClass?: string, platform?: string, provides?: string, castType?: string }} client
 * @returns {"local"|"tv"|"speaker"|"phone"|"app"}
 */
export function classifyClientKind(client) {
  if (!client || client.castType === "local") return "local";
  const blob = [
    client.name,
    client.product,
    client.deviceClass,
    client.platform,
    client.provides,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (
    /\b(speaker|soundbar|nest mini|nest audio|home mini|homepod|plexamp|audio only|google home)\b/.test(
      blob,
    )
  ) {
    return "speaker";
  }
  if (
    /\b(tv|roku|shield|fire tv|apple tv|android tv|smart tv|chromecast|bravia|webos|tizen)\b/.test(
      blob,
    ) ||
    client.deviceClass === "tv" ||
    client.deviceClass === "stb"
  ) {
    return "tv";
  }
  if (
    /\b(phone|mobile|iphone|ipad|tablet|android|ios)\b/.test(blob) ||
    client.deviceClass === "phone" ||
    client.deviceClass === "mobile" ||
    client.deviceClass === "tablet"
  ) {
    return "phone";
  }
  if (client.castType === "chromecast") {
    // Cast without a clear TV/speaker hint — treat as TV (safer label than speaker).
    return /speaker|audio/.test(blob) ? "speaker" : "tv";
  }
  return "app";
}

function withClientKind(client) {
  const kind = classifyClientKind(client);
  return {
    ...client,
    kind,
    kindLabel:
      kind === "local"
        ? "This device"
        : kind === "tv"
          ? "TV"
          : kind === "speaker"
            ? "Speaker"
            : kind === "phone"
              ? "Phone"
              : "App",
  };
}

function isIpv4Address(value) {
  return Boolean(parseIpv4Parts(String(value || "").trim()));
}

function parseIpv4Parts(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return null;
  return parts;
}

/**
 * Prefer IPv4 cast targets over .local mDNS duplicates of the same name.
 * @param {Map<string, any>} byId
 * @param {any} player
 */
function upsertPlayer(byId, player) {
  if (!player?.machineIdentifier) return;
  const existing = [...byId.values()].find(
    (c) =>
      c.castType === player.castType &&
      c.castType === "chromecast" &&
      String(c.name || "").toLowerCase() ===
        String(player.name || "").toLowerCase() &&
      c.machineIdentifier !== player.machineIdentifier,
  );
  if (existing) {
    const existingIp = isIpv4Address(existing.address || existing.host);
    const nextIp = isIpv4Address(player.address || player.host);
    if (nextIp && !existingIp) {
      byId.delete(existing.machineIdentifier);
      byId.set(player.machineIdentifier, player);
      return;
    }
    if (existingIp && !nextIp) {
      return;
    }
  }
  byId.set(player.machineIdentifier, player);
}

/**
 * Merge local playback + Plex controllable players + Chromecast devices.
 */
export async function listClients(settings = getWorkoutConfig()) {
  requireToken(settings);
  const local = {
    name: "This device (play here)",
    host: "local",
    address: "local",
    port: 0,
    machineIdentifier: LOCAL_CLIENT_ID,
    product: "Arrs Hub",
    deviceClass: "local",
    platform: "Arrs Hub",
    provides: "player",
    castType: "local",
    protocolCapabilities: ["playback"],
  };

  const [plexPlayers, castDevices] = await Promise.all([
    listPlexPlayers(settings).catch((err) => {
      console.error("Plex player discovery failed:", err?.message || err);
      return [];
    }),
    import("./cast.mjs")
      .then((mod) => mod.discoverCastDevices(3500))
      .catch((err) => {
        console.error("Cast discovery failed:", err?.message || err);
        return [];
      }),
  ]);

  /** @type {Map<string, any>} */
  const byId = new Map();
  byId.set(local.machineIdentifier, local);
  for (const player of [...plexPlayers, ...castDevices]) {
    upsertPlayer(byId, player);
  }
  const kindRank = { local: 0, tv: 1, phone: 2, app: 3, speaker: 4 };
  return [...byId.values()]
    .map(withClientKind)
    .sort(
      (a, b) =>
        (kindRank[a.kind] ?? 9) - (kindRank[b.kind] ?? 9) ||
        String(a.name || "").localeCompare(String(b.name || "")),
    );
}

async function listPlexPlayers(settings) {
  /** @type {Map<string, any>} */
  const players = new Map();

  // 1) Players currently visible to the PMS
  try {
    const json = await plexFetch(
      settings.plexBaseUrl,
      settings.plexToken.trim(),
      "/clients",
    );
    const container = mediaContainer(json);
    for (const client of asArray(container.Server)) {
      if (!client.machineIdentifier) continue;
      const caps = String(client.protocolCapabilities || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      players.set(client.machineIdentifier, {
        name: client.name,
        host: client.host || client.address,
        address: client.address || client.host,
        port: Number(client.port) || 32400,
        machineIdentifier: client.machineIdentifier,
        product: client.product || "Plex",
        deviceClass: client.deviceClass || "plex",
        platform: client.platform || client.product || "Plex",
        provides: caps.join(",") || "player",
        castType: "plex",
        protocolCapabilities: caps.length ? caps : ["playback"],
      });
    }
  } catch {
    // ignore — plex.tv resources may still work
  }

  // 2) Account devices that provide player + are present
  try {
    const url = new URL("https://plex.tv/api/resources");
    url.searchParams.set("includeHttps", "1");
    url.searchParams.set("includeRelay", "1");
    url.searchParams.set("X-Plex-Token", settings.plexToken.trim());
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-Plex-Token": settings.plexToken.trim(),
        "X-Plex-Client-Identifier": getPlexClientId(),
        "X-Plex-Product": "Arrs Hub",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const json = await res.json();
      const devices = asArray(json?.MediaContainer?.Device || json?.Device || json);
      for (const device of devices) {
        const provides = String(device.provides || "");
        if (!provides.includes("player")) continue;
        if (device.presence === false || device.presence === "0") continue;
        const id = device.clientIdentifier || device.machineIdentifier;
        if (!id || players.has(id)) continue;

        const connections = asArray(device.Connection || device.connections);
        const localConn =
          connections.find((c) => c.local === true || c.local === 1) ||
          connections[0];
        players.set(id, {
          name: device.name || device.device || "Plex player",
          host: localConn?.address || device.publicAddress || "",
          address: localConn?.address || device.publicAddress || "",
          port: Number(localConn?.port) || 32400,
          machineIdentifier: id,
          product: device.product || "Plex",
          deviceClass: device.deviceClass || device.device || "plex",
          platform: device.platform || device.product || "Plex",
          provides: String(device.provides || "player"),
          castType: "plex",
          protocolCapabilities: ["playback"],
          presence: true,
        });
      }
    }
  } catch (err) {
    console.error("plex.tv resources failed:", err?.message || err);
  }

  return [...players.values()];
}

/**
 * Format day title from pattern. {n}=1, {nn}=01
 * @param {string} pattern
 * @param {number} day
 */
export function formatDayTitle(pattern, day) {
  return String(pattern || "Day {n}")
    .replaceAll("{nn}", String(day).padStart(2, "0"))
    .replaceAll("{n}", String(day));
}

/**
 * @param {number} day
 * @param {string} pattern
 * @param {string} title
 */
function titleMatchesDay(day, pattern, title) {
  const expected = formatDayTitle(pattern, day).toLowerCase();
  const value = String(title || "").toLowerCase();
  if (value === expected) return true;
  if (value.includes(expected)) return true;
  // Loose fallback: "Day 7" / "day07"
  const loose = new RegExp(`\\bday\\s*0*${day}\\b`, "i");
  return loose.test(value);
}

async function listSectionItems(settings) {
  requireToken(settings);
  if (!settings.librarySectionId) {
    throw new Error("Pick a Plex library that holds your workout videos.");
  }
  const json = await plexFetch(
    settings.plexBaseUrl,
    settings.plexToken.trim(),
    `/library/sections/${settings.librarySectionId}/all`,
    { query: { includeGuids: 0 } },
  );
  const container = mediaContainer(json);
  const items = [
    ...asArray(container.Metadata),
    ...asArray(container.Video),
    ...asArray(container.Directory),
  ];
  return items
    .filter((item) => item?.ratingKey && item?.title)
    .map((item) => ({
      ratingKey: String(item.ratingKey),
      key: item.key || `/library/metadata/${item.ratingKey}`,
      title: item.title,
      type: item.type,
      duration: item.duration,
      index: Number(item.index) || null,
      parentIndex: Number(item.parentIndex) || null,
      grandparentTitle: item.grandparentTitle || "",
      parentTitle: item.parentTitle || "",
    }));
}

/**
 * List TV episodes in a library section (type=4).
 */
async function listSectionEpisodes(settings) {
  requireToken(settings);
  if (!settings.librarySectionId) {
    throw new Error("Pick a Plex library that holds your workout videos.");
  }
  const json = await plexFetch(
    settings.plexBaseUrl,
    settings.plexToken.trim(),
    `/library/sections/${settings.librarySectionId}/all`,
    { query: { type: 4, includeGuids: 0 } },
  );
  const container = mediaContainer(json);
  return asArray(container.Metadata)
    .filter((item) => item?.ratingKey && item?.title)
    .map((item) => ({
      ratingKey: String(item.ratingKey),
      key: item.key || `/library/metadata/${item.ratingKey}`,
      title: item.title,
      type: item.type || "episode",
      duration: item.duration,
      index: Number(item.index) || null,
      parentIndex: Number(item.parentIndex) || null,
      grandparentTitle: String(item.grandparentTitle || ""),
      parentTitle: String(item.parentTitle || ""),
    }));
}

function showTitleMatches(needle, episode) {
  const want = String(needle || "")
    .trim()
    .toLowerCase();
  if (!want) return true;
  const hay = `${episode.grandparentTitle} ${episode.parentTitle}`.toLowerCase();
  return hay.includes(want);
}

function discoverByEpisode(settings, episodes) {
  const showTitle = settings.showTitle || "Fit With the Force";
  const seasonNumber = Number(settings.seasonNumber) || 1;
  const warmupEpisode = Number(settings.warmupEpisode) || 2;
  const firstDayEpisode = Number(settings.firstDayEpisode) || warmupEpisode + 1;
  const dayCount = Math.max(1, Number(settings.dayCount) || 30);
  const pattern = settings.dayTitlePattern || "Day {n}";
  const warmupNeedle = String(settings.warmupTitle || "Warm Up")
    .trim()
    .toLowerCase();

  const inShow = episodes
    .filter((ep) => showTitleMatches(showTitle, ep))
    .filter((ep) => ep.parentIndex == null || ep.parentIndex === seasonNumber)
    .sort((a, b) => (a.index || 0) - (b.index || 0));

  if (inShow.length === 0) {
    return {
      warmup: null,
      days: [],
      itemCount: episodes.length,
      matchMode: "episode",
      showTitle,
      seasonNumber,
      hint: `No episodes found for show matching "${showTitle}" in season ${seasonNumber}. Pick the TV library that contains it.`,
    };
  }

  const byIndex = new Map();
  for (const ep of inShow) {
    if (ep.index != null) byIndex.set(ep.index, ep);
  }

  // Prefer titles: "Full Body Warm Up…" and "… | Day 1"
  const warmup =
    inShow.find((ep) => ep.title.toLowerCase().includes(warmupNeedle)) ||
    byIndex.get(warmupEpisode) ||
    null;

  /** @type {{ day: number, title: string, ratingKey: string, episode: number|null }[]} */
  const days = [];
  for (let day = 1; day <= dayCount; day += 1) {
    const byTitle = inShow.find((ep) =>
      titleMatchesDay(day, pattern, ep.title),
    );
    if (byTitle) {
      days.push({
        day,
        title: byTitle.title,
        ratingKey: byTitle.ratingKey,
        episode: byTitle.index,
      });
      continue;
    }

    // Fallback: Day 1 = firstDayEpisode, Day 2 = next, …
    const episodeNum = firstDayEpisode + day - 1;
    const byEp = byIndex.get(episodeNum);
    if (byEp) {
      days.push({
        day,
        title: byEp.title,
        ratingKey: byEp.ratingKey,
        episode: episodeNum,
      });
    }
  }

  return {
    warmup: warmup
      ? {
          title: warmup.title,
          ratingKey: warmup.ratingKey,
          episode: warmup.index,
        }
      : null,
    days,
    itemCount: inShow.length,
    matchMode: "episode",
    showTitle,
    seasonNumber,
    warmupEpisode,
    firstDayEpisode,
  };
}

function discoverByTitle(settings, items) {
  const pattern = settings.dayTitlePattern || "Day {n}";
  const warmupNeedle = String(settings.warmupTitle || "Warm Up")
    .trim()
    .toLowerCase();

  const warmup =
    items.find((item) => item.title.toLowerCase() === warmupNeedle) ||
    items.find((item) => item.title.toLowerCase().includes(warmupNeedle)) ||
    null;

  const maxScan = Math.max(Number(settings.dayCount) || 30, 60);
  /** @type {{ day: number, title: string, ratingKey: string }[]} */
  const days = [];
  for (let day = 1; day <= maxScan; day += 1) {
    const match = items.find((item) =>
      titleMatchesDay(day, pattern, item.title),
    );
    if (match) {
      days.push({
        day,
        title: match.title,
        ratingKey: match.ratingKey,
      });
    }
  }

  return {
    warmup: warmup
      ? {
          title: warmup.title,
          ratingKey: warmup.ratingKey,
        }
      : null,
    days,
    itemCount: items.length,
    matchMode: "title",
  };
}

export async function discoverWorkoutDays(settings = getWorkoutConfig()) {
  const mode = settings.matchMode === "title" ? "title" : "episode";

  if (mode === "episode") {
    const episodes = await listSectionEpisodes(settings);
    const result = discoverByEpisode(settings, episodes);
    // If episode mode found nothing, try title match as a soft fallback
    if (!result.warmup && result.days.length === 0) {
      const items = await listSectionItems(settings);
      const titleResult = discoverByTitle(settings, items);
      if (titleResult.warmup || titleResult.days.length > 0) {
        return {
          ...titleResult,
          hint:
            result.hint ||
            "Episode match found nothing; fell back to title matching.",
        };
      }
    }
    return result;
  }

  const items = await listSectionItems(settings);
  return discoverByTitle(settings, items);
}

/**
 * Create a play queue with warmup (optional) + day video, then tell the client to play.
 * @param {number} day
 * @param {object} [settings]
 * @param {{ clientMachineId?: string, publicBaseUrl?: string, skipWarmup?: boolean }} [options]
 */
export async function playWorkoutDay(
  day,
  settings = getWorkoutConfig(),
  options = {},
) {
  requireToken(settings);
  const clientMachineId =
    options.clientMachineId?.trim() || settings.clientMachineId;
  if (!clientMachineId) {
    throw new Error(
      "Pick where to play (This device, or a Plex TV/phone/tablet).",
    );
  }

  const dayNum = Number(day);
  if (!Number.isFinite(dayNum) || dayNum < 1) {
    throw new Error("Pick a valid day number.");
  }

  const identity = await testPlexConnection(settings);
  const discovery = await discoverWorkoutDays(settings);
  const dayItem = discovery.days.find((item) => item.day === dayNum);
  if (!dayItem) {
    throw new Error(
      settings.matchMode === "title"
        ? `Could not find a video matching "${formatDayTitle(settings.dayTitlePattern, dayNum)}" in that library.`
        : `Could not find Day ${dayNum} (episode ${(Number(settings.firstDayEpisode) || 3) + dayNum - 1}) for "${settings.showTitle || "Fit With the Force"}".`,
    );
  }
  if (!discovery.warmup) {
    throw new Error(
      settings.matchMode === "title"
        ? `Could not find warm-up video titled like "${settings.warmupTitle}".`
        : `Could not find warm-up episode ${settings.warmupEpisode || 2} for "${settings.showTitle || "Fit With the Force"}".`,
    );
  }

  const publicBaseUrl = String(options.publicBaseUrl || "").trim();

  if (clientMachineId === LOCAL_CLIENT_ID) {
    const warmupMedia = await getBrowserPlayable(
      settings,
      discovery.warmup.ratingKey,
      discovery.warmup.title,
      { publicBaseUrl },
    );
    const dayMedia = await getBrowserPlayable(
      settings,
      dayItem.ratingKey,
      dayItem.title,
      { publicBaseUrl },
    );
    return {
      ok: true,
      mode: "local",
      client: "This device",
      warmup: discovery.warmup.title,
      day: dayItem.title,
      playlist: [warmupMedia, dayMedia],
    };
  }

  const clients = await listClients(settings);
  const client = clients.find(
    (item) => item.machineIdentifier === clientMachineId,
  );
  if (!client) {
    throw new Error(
      "Selected device is not available. Hit Refresh, or choose This device.",
    );
  }

  // Chromecast / Cast receivers on the LAN
  if (client.castType === "chromecast") {
    const warmupMedia = await getBrowserPlayable(
      settings,
      discovery.warmup.ratingKey,
      discovery.warmup.title,
      { publicBaseUrl },
    );
    const dayMedia = await getBrowserPlayable(
      settings,
      dayItem.ratingKey,
      dayItem.title,
      { publicBaseUrl },
    );
    const { castPlaylistToDevice } = await import("./cast.mjs");
    const skipWarmup = Boolean(options.skipWarmup);
    if (skipWarmup) {
      await castPlaylistToDevice(client.address || client.host, [dayMedia], {
        waitForFinish: false,
      });
      return {
        ok: true,
        mode: "cast",
        client: client.name,
        kind: client.kind,
        warmup: discovery.warmup.title,
        day: dayItem.title,
        phase: "day",
      };
    }
    // Cast warm-up only; hub UI confirms before starting the day video.
    await castPlaylistToDevice(client.address || client.host, [warmupMedia], {
      waitForFinish: true,
    });
    return {
      ok: true,
      mode: "cast",
      client: client.name,
      kind: client.kind,
      warmup: discovery.warmup.title,
      day: dayItem.title,
      phase: "warmup-done",
      awaitingDayConfirm: true,
    };
  }

  if (client.castType !== "plex" && client.castType !== "chromecast") {
    throw new Error("Choose This device, a Cast device, or a Plex player.");
  }

  if (!client.address || client.address === "local") {
    throw new Error(
      `"${client.name}" can’t be controlled remotely right now. Plex Desktop often doesn’t advertise as a castable player — use This device for this laptop, or cast to a TV/Chromecast.`,
    );
  }

  const serverId = identity.machineIdentifier;
  const warmupUri = libraryUri(serverId, discovery.warmup.ratingKey);
  const dayUri = libraryUri(serverId, dayItem.ratingKey);

  // Create queue with warm-up, then append the day video so they play in order.
  const queueJson = await plexFetch(
    settings.plexBaseUrl,
    settings.plexToken.trim(),
    "/playQueues",
    {
      method: "POST",
      query: {
        type: "video",
        shuffle: 0,
        repeat: 0,
        continuous: 1,
        includeChapters: 1,
        uri: warmupUri,
      },
    },
  );
  const queue = mediaContainer(queueJson);
  const playQueueID = queue.playQueueID;
  if (!playQueueID) {
    throw new Error("Plex did not return a play queue id.");
  }

  await plexFetch(
    settings.plexBaseUrl,
    settings.plexToken.trim(),
    `/playQueues/${playQueueID}`,
    {
      method: "PUT",
      query: {
        uri: dayUri,
        type: "video",
      },
    },
  );

  const serverUrl = new URL(normalizePlexBaseUrl(settings.plexBaseUrl));
  const playUrl = new URL(
    "/player/playback/playMedia",
    `http://${client.address}:${client.port}/`,
  );
  playUrl.searchParams.set("commandID", String(Date.now() % 100000));
  playUrl.searchParams.set("providerIdentifier", "com.plexapp.plugins.library");
  playUrl.searchParams.set("machineIdentifier", serverId);
  playUrl.searchParams.set("protocol", serverUrl.protocol.replace(":", ""));
  playUrl.searchParams.set("address", serverUrl.hostname);
  playUrl.searchParams.set("port", serverUrl.port || "32400");
  playUrl.searchParams.set("offset", "0");
  playUrl.searchParams.set("type", "video");
  playUrl.searchParams.set(
    "key",
    `/library/metadata/${discovery.warmup.ratingKey}`,
  );
  playUrl.searchParams.set(
    "containerKey",
    `/playQueues/${playQueueID}?window=100&own=1`,
  );
  playUrl.searchParams.set("token", settings.plexToken.trim());
  playUrl.searchParams.set("X-Plex-Token", settings.plexToken.trim());
  playUrl.searchParams.set(
    "X-Plex-Target-Client-Identifier",
    client.machineIdentifier,
  );

  const playRes = await fetch(playUrl, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Plex-Token": settings.plexToken.trim(),
      "X-Plex-Client-Identifier": getPlexClientId(),
      "X-Plex-Target-Client-Identifier": client.machineIdentifier,
      "X-Plex-Product": "Arrs Hub",
      "X-Plex-Device-Name": "Arrs Hub",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!playRes.ok) {
    const body = await playRes.text();
    throw new Error(
      `Could not start playback on ${client.name}: HTTP ${playRes.status}${
        body ? ` — ${body.slice(0, 180)}` : ""
      }`,
    );
  }

  return {
    ok: true,
    mode: "client",
    client: client.name,
    warmup: discovery.warmup.title,
    day: dayItem.title,
    playQueueID,
  };
}

/**
 * Plex Android has no built-in progressive `protocol=http` conversion profile.
 * Without this extra target, `/video/:/transcode/universal/start.mp4` returns 400
 * ("No conversion profile found for protocol http").
 */
const PLEX_BROWSER_TRANSCODE_PROFILE =
  "add-transcode-target(type=videoProfile&context=streaming&protocol=http&container=mp4&videoCodec=h264&audioCodec=aac&subtitleCodec=srt)+add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=mpegts&videoCodec=h264&audioCodec=aac&subtitleCodec=srt)";

/**
 * Build universal-transcode query params shared by decision + start.
 * @param {object} settings
 * @param {string} ratingKey
 * @param {{ offsetMs?: number, session?: string }} [opts]
 */
function buildPlexTranscodeParams(settings, ratingKey, opts = {}) {
  const token = settings.plexToken.trim();
  const session = String(opts.session || crypto.randomUUID());
  const params = {
    path: `/library/metadata/${ratingKey}`,
    mediaIndex: "0",
    partIndex: "0",
    protocol: "http",
    fastSeek: "1",
    directPlay: "0",
    directStream: "0",
    videoCodecs: "h264",
    audioCodecs: "aac",
    subtitleSize: "100",
    audioBoost: "100",
    location: "lan",
    addDebugOverlay: "0",
    autoAdjustQuality: "0",
    session,
    hasMDE: "1",
    "X-Plex-Platform": "Android",
    "X-Plex-Client-Identifier": PLEX_MEDIA_CLIENT_ID,
    "X-Plex-Product": PLEX_PRODUCT,
    "X-Plex-Device-Name": PLEX_PRODUCT,
    "X-Plex-Client-Profile-Extra": PLEX_BROWSER_TRANSCODE_PROFILE,
    "X-Plex-Token": token,
  };
  const offsetMs = Math.max(0, Number(opts.offsetMs) || 0);
  if (offsetMs > 0) {
    params.offset = String(Math.floor(offsetMs));
  }
  return params;
}

/**
 * Plex often 400s universal start unless decision runs first for the same session.
 * @param {object} settings
 * @param {Record<string, string>} params
 */
async function ensurePlexTranscodeDecision(settings, params) {
  const base = normalizePlexBaseUrl(settings.plexBaseUrl);
  const url = new URL("/video/:/transcode/universal/decision", `${base}/`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const token = settings.plexToken.trim();
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Plex-Token": token,
      "X-Plex-Client-Identifier": PLEX_MEDIA_CLIENT_ID,
      "X-Plex-Product": PLEX_PRODUCT,
      "X-Plex-Platform": "Android",
      "X-Plex-Client-Profile-Extra": PLEX_BROWSER_TRANSCODE_PROFILE,
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Plex transcode decision HTTP ${res.status}${
        body ? `: ${body.slice(0, 160)}` : ""
      }`,
    );
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  const container = mediaContainer(json);
  const code = Number(container.generalDecisionCode) || 0;
  if (code === 2000) {
    throw new Error(
      container.generalDecisionText ||
        container.transcodeDecisionText ||
        "Plex cannot direct play or convert this item.",
    );
  }
}

/**
 * Resolve a Plex upstream URL the hub can fetch (localhost PMS is fine here).
 * Prefer direct H.264 MP4 (including AC3 audio — common on workout rips);
 * otherwise universal H.264/AAC transcode with an Android http profile.
 * @param {object} settings
 * @param {string} ratingKey
 * @param {{ offsetMs?: number }} [opts]
 */
async function resolvePlexUpstreamStream(settings, ratingKey, opts = {}) {
  const base = normalizePlexBaseUrl(settings.plexBaseUrl);
  const token = settings.plexToken.trim();
  const metaJson = await plexFetch(
    settings.plexBaseUrl,
    token,
    `/library/metadata/${ratingKey}`,
  );
  const meta = asArray(mediaContainer(metaJson).Metadata)[0];
  if (!meta) {
    throw new Error(`Could not load media for ratingKey ${ratingKey}.`);
  }

  const media = asArray(meta.Media)[0];
  const part = asArray(media?.Part)[0];
  if (!part?.key && !meta.ratingKey) {
    throw new Error(`No playable part for ratingKey ${ratingKey}.`);
  }

  const container = String(
    part?.container || media?.container || "",
  ).toLowerCase();
  const videoCodec = String(
    media?.videoCodec || part?.videoCodec || "",
  ).toLowerCase();
  const audioCodec = String(
    media?.audioCodec || part?.audioCodec || "",
  ).toLowerCase();
  const friendlyContainer = ["mp4", "m4v", "mov", "webm"].includes(container);
  const friendlyVideo = ["", "h264", "avc", "avc1"].includes(videoCodec);
  // Do not require AAC: AC3-in-MP4 is common, and forcing Android+http
  // universal transcode without a client profile returns Plex HTTP 400.
  const directPlayable =
    friendlyContainer && friendlyVideo && Boolean(part?.key);

  const offsetMs = Math.max(0, Number(opts.offsetMs) || 0);
  let plexUrl;
  let seekable = false;
  let mode = "direct";
  let session = "";
  /** @type {Record<string, string>|null} */
  let transcodeParams = null;

  if (directPlayable) {
    const direct = new URL(part.key, `${base}/`);
    direct.searchParams.set("X-Plex-Token", token);
    plexUrl = direct.toString();
    seekable = true;
    mode = "direct";
  } else {
    transcodeParams = buildPlexTranscodeParams(settings, ratingKey, {
      offsetMs,
    });
    session = transcodeParams.session;
    await ensurePlexTranscodeDecision(settings, transcodeParams);
    const stream = new URL(
      "/video/:/transcode/universal/start.mp4",
      `${base}/`,
    );
    for (const [key, value] of Object.entries(transcodeParams)) {
      stream.searchParams.set(key, value);
    }
    plexUrl = stream.toString();
    seekable = false;
    mode = "transcode";
  }

  return {
    title: meta.title || String(ratingKey),
    ratingKey: String(ratingKey),
    plexUrl,
    seekable,
    mode,
    session,
    partKey: part?.key || "",
    container,
    videoCodec,
    audioCodec,
    durationMs: Number(meta.duration) || Number(part?.duration) || null,
    contentType: "video/mp4",
  };
}

/**
 * Browser/mobile-playable item. When publicBaseUrl is set (API clients),
 * return a hub-proxied URL so phones never hit plexBaseUrl=localhost.
 * @param {object} settings
 * @param {string} ratingKey
 * @param {string} title
 * @param {{ publicBaseUrl?: string }} [options]
 */
async function getBrowserPlayable(
  settings,
  ratingKey,
  title,
  options = {},
) {
  const upstream = await resolvePlexUpstreamStream(settings, ratingKey);
  const publicBaseUrl = String(options.publicBaseUrl || "").trim();
  // Always proxy via Arrs Hub — plexBaseUrl is often http://localhost:32400,
  // which breaks every in-app play on phones/tablets (and cast devices).
  const mediaPath = `/api/workouts/media/${encodeURIComponent(String(ratingKey))}`;
  const url = publicBaseUrl
    ? new URL(
        mediaPath,
        publicBaseUrl.endsWith("/") ? publicBaseUrl : `${publicBaseUrl}/`,
      ).toString()
    : mediaPath;

  return {
    title: title || upstream.title,
    ratingKey: String(ratingKey),
    url,
    seekable: upstream.seekable,
    durationMs: upstream.durationMs,
    streamMode: upstream.mode,
  };
}

/**
 * Proxy Plex media to the mobile/browser player (Range + offset supported).
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string} ratingKey
 */
export async function streamWorkoutMedia(req, res, ratingKey) {
  const settings = getWorkoutConfig();
  requireToken(settings);
  const key = String(ratingKey || "").trim();
  if (!key) {
    res.status(400).json({ error: "Missing ratingKey." });
    return;
  }

  const offsetMs = Math.max(
    0,
    Number(req.query?.offset) || Number(req.query?.X_Plex_Offset) || 0,
  );

  let upstream;
  try {
    upstream = await resolvePlexUpstreamStream(settings, key, { offsetMs });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const missing = /could not load media|no playable part/i.test(message);
    res.status(missing ? 404 : 502).json({
      error: missing
        ? `Media not found in Plex (${key}).`
        : `Could not resolve Plex stream: ${message}`,
      code: missing ? "MEDIA_MISSING" : "PLEX_UPSTREAM",
    });
    return;
  }

  const token = settings.plexToken.trim();
  const headers = {
    "X-Plex-Token": token,
    Accept: "*/*",
  };
  if (upstream.mode === "transcode") {
    headers["X-Plex-Client-Identifier"] = PLEX_MEDIA_CLIENT_ID;
    headers["X-Plex-Product"] = PLEX_PRODUCT;
    headers["X-Plex-Platform"] = "Android";
    headers["X-Plex-Client-Profile-Extra"] = PLEX_BROWSER_TRANSCODE_PROFILE;
  }
  if (req.headers.range) {
    headers.Range = String(req.headers.range);
  }

  let plexRes;
  try {
    plexRes = await fetch(upstream.plexUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(120000),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(502).json({
      error: `Plex stream unreachable (is PMS running on ${normalizePlexBaseUrl(settings.plexBaseUrl)}?): ${message}`,
      code: "PLEX_UNREACHABLE",
    });
    return;
  }

  // Transcode can still 400 on some PMS builds; fall back to the raw part when present.
  if (
    !plexRes.ok &&
    plexRes.status !== 206 &&
    upstream.mode === "transcode" &&
    upstream.partKey
  ) {
    await plexRes.text().catch(() => "");
    const direct = new URL(
      upstream.partKey,
      `${normalizePlexBaseUrl(settings.plexBaseUrl)}/`,
    );
    direct.searchParams.set("X-Plex-Token", token);
    try {
      plexRes = await fetch(direct.toString(), {
        method: "GET",
        headers: {
          "X-Plex-Token": token,
          Accept: "*/*",
          ...(req.headers.range
            ? { Range: String(req.headers.range) }
            : {}),
        },
        signal: AbortSignal.timeout(120000),
      });
      if (plexRes.ok || plexRes.status === 206) {
        upstream.mode = "direct-fallback";
        upstream.seekable = true;
        upstream.contentType = "video/mp4";
      }
    } catch {
      // keep original failure below
    }
  }

  if (!plexRes.ok && plexRes.status !== 206) {
    const body = await plexRes.text().catch(() => "");
    const safeUrl = String(upstream.plexUrl || "").replaceAll(token, "REDACTED");
    console.warn(
      `[workouts/media] Plex HTTP ${plexRes.status} for ${key} mode=${upstream.mode} url=${safeUrl} body=${body.slice(0, 200)}`,
    );
    res.status(plexRes.status === 404 ? 404 : 502).json({
      error:
        plexRes.status === 404
          ? `Plex media missing for ${key}.`
          : `Plex returned HTTP ${plexRes.status}${body ? `: ${body.slice(0, 160)}` : ""}`,
      code: plexRes.status === 404 ? "MEDIA_MISSING" : "PLEX_HTTP",
    });
    return;
  }

  res.status(plexRes.status);
  const passHeaders = [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "content-disposition",
  ];
  for (const name of passHeaders) {
    const value = plexRes.headers.get(name);
    if (value) res.setHeader(name, value);
  }
  if (!res.getHeader("content-type")) {
    res.setHeader("Content-Type", upstream.contentType || "video/mp4");
  }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Arrs-Stream-Mode", upstream.mode);

  if (!plexRes.body) {
    const buf = Buffer.from(await plexRes.arrayBuffer());
    res.end(buf);
    return;
  }

  const { Readable } = await import("node:stream");
  Readable.fromWeb(plexRes.body).pipe(res);
}

function libraryUri(serverId, ratingKey) {
  return `server://${serverId}/com.plexapp.plugins.library/library/metadata/${ratingKey}`;
}

function requireToken(settings) {
  if (!settings?.plexToken?.trim()) {
    throw new Error("Sign in with Plex first.");
  }
}
