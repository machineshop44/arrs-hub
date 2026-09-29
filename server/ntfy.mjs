/**
 * ntfy push alerts (ntfy Android app): new Ombi requests, *arr queue items
 * that need attention, and Port Watch service down/up transitions.
 * Polls on an interval inside the Hub; failures are logged, never thrown.
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, ensureDataDirs } from "./config.mjs";
import { getArrQueues, getOmbiPendingRequests } from "./activity.mjs";
import { getWatchStatus } from "./watchdog.mjs";
import {
  createServiceUrlResolver,
  isLoopbackHost,
  hostnameOfUrl,
  parseHttpUrl,
} from "./url-policy.mjs";

export const NTFY_SETTINGS_PATH = path.join(DATA_DIR, "ntfy-settings.json");
export const NTFY_STATE_PATH = path.join(DATA_DIR, "ntfy-state.json");

const TOPIC_RE = /^[-_A-Za-z0-9]{1,64}$/;
const SEEN_LIMIT = 500;
const FIRST_RUN_DELAY_MS = 30_000;

const QUEUE_APP_LABELS = {
  sonarr: "Sonarr",
  radarr: "Radarr",
  lidarr: "Lidarr",
  readarr: "Readarr",
  whisparr: "Whisparr",
};

export function defaultNtfySettings() {
  return {
    enabled: false,
    serverUrl: "https://ntfy.sh",
    topic: "",
    accessToken: "",
    /** Optional link opened when tapping a notification (e.g. Hub LAN/WAN URL). */
    clickUrl: "",
    intervalSeconds: 120,
    /** Service must stay in its new state this long before alerting. */
    serviceDebounceSeconds: 60,
    /** Min gap between alerts for the same service (flap guard). */
    serviceCooldownSeconds: 600,
    events: {
      ombiPending: true,
      queueIssues: true,
      serviceDown: true,
      serviceUp: true,
    },
  };
}

function atomicWriteJson(filePath, value) {
  ensureDataDirs();
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function maskKey(key) {
  if (!key) return "";
  if (key.length <= 8) return "••••••••";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function pickSecret(incoming, current) {
  if (typeof incoming !== "string") return current;
  const trimmed = incoming.trim();
  if (!trimmed) return current;
  if (trimmed.includes("…") || trimmed.includes("•")) return current;
  return trimmed;
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function loadNtfySettings() {
  const defaults = defaultNtfySettings();
  const raw = readJson(NTFY_SETTINGS_PATH) || {};
  return {
    ...defaults,
    ...raw,
    accessToken: typeof raw.accessToken === "string" ? raw.accessToken : "",
    events: { ...defaults.events, ...(raw.events ?? {}) },
  };
}

export function saveNtfySettings(settings) {
  atomicWriteJson(NTFY_SETTINGS_PATH, settings);
  return settings;
}

export function publicNtfySettings(settings = loadNtfySettings()) {
  return {
    enabled: Boolean(settings.enabled),
    serverUrl: settings.serverUrl,
    topic: settings.topic,
    accessToken: settings.accessToken ? maskKey(settings.accessToken) : "",
    accessTokenSet: Boolean(settings.accessToken),
    clickUrl: settings.clickUrl || "",
    intervalSeconds: settings.intervalSeconds,
    serviceDebounceSeconds: settings.serviceDebounceSeconds,
    serviceCooldownSeconds: settings.serviceCooldownSeconds,
    events: { ...settings.events },
  };
}

/**
 * @param {Record<string, unknown>} patch
 *   accessToken: blank/masked keeps saved; `clearAccessToken: true` removes it.
 */
export function updateNtfySettings(patch = {}) {
  const current = loadNtfySettings();
  const body = patch ?? {};

  let serverUrl = current.serverUrl;
  if (body.serverUrl !== undefined) {
    const raw = String(body.serverUrl || "").trim().replace(/\/+$/, "");
    serverUrl = raw || defaultNtfySettings().serverUrl;
    if (!parseHttpUrl(serverUrl)) {
      throw new Error("ntfy server URL must start with http:// or https://");
    }
  }

  let topic = current.topic;
  if (body.topic !== undefined) {
    topic = String(body.topic || "").trim();
    if (topic && !TOPIC_RE.test(topic)) {
      throw new Error(
        "ntfy topic may only use letters, numbers, - and _ (max 64 chars)",
      );
    }
  }

  let clickUrl = current.clickUrl || "";
  if (body.clickUrl !== undefined) {
    clickUrl = String(body.clickUrl || "").trim();
    if (clickUrl && !parseHttpUrl(clickUrl)) {
      throw new Error("Click URL must start with http:// or https://");
    }
  }

  const events = { ...current.events };
  if (body.events && typeof body.events === "object") {
    for (const key of Object.keys(defaultNtfySettings().events)) {
      if (body.events[key] !== undefined) events[key] = Boolean(body.events[key]);
    }
  }

  const next = {
    ...current,
    enabled:
      body.enabled !== undefined ? Boolean(body.enabled) : current.enabled,
    serverUrl,
    topic,
    accessToken:
      body.clearAccessToken === true
        ? ""
        : pickSecret(body.accessToken, current.accessToken),
    clickUrl,
    intervalSeconds: clampInt(
      body.intervalSeconds ?? current.intervalSeconds,
      30,
      3600,
      120,
    ),
    serviceDebounceSeconds: clampInt(
      body.serviceDebounceSeconds ?? current.serviceDebounceSeconds,
      0,
      3600,
      60,
    ),
    serviceCooldownSeconds: clampInt(
      body.serviceCooldownSeconds ?? current.serviceCooldownSeconds,
      0,
      86400,
      600,
    ),
    events,
  };
  saveNtfySettings(next);
  restartNtfyLoop();
  return next;
}

/**
 * Publish one message (JSON publish to the server root).
 * @param {ReturnType<typeof loadNtfySettings>} settings
 * @param {{ title: string, message: string, priority?: number, tags?: string[], click?: string }} payload
 */
export async function sendNtfy(settings, payload) {
  const base = String(settings.serverUrl || "").trim().replace(/\/+$/, "");
  if (!parseHttpUrl(base)) {
    return { ok: false, message: "Invalid ntfy server URL" };
  }
  if (!TOPIC_RE.test(String(settings.topic || ""))) {
    return { ok: false, message: "Set an ntfy topic first." };
  }
  const headers = { "Content-Type": "application/json" };
  if (settings.accessToken) {
    headers.Authorization = `Bearer ${settings.accessToken}`;
  }
  const body = {
    topic: settings.topic,
    title: String(payload.title || "Arrs Hub").slice(0, 250),
    message: String(payload.message || "").slice(0, 3500) || " ",
    priority: clampInt(payload.priority ?? 3, 1, 5, 3),
  };
  if (payload.tags?.length) body.tags = payload.tags;
  if (payload.click && parseHttpUrl(payload.click)) body.click = payload.click;
  try {
    const res = await fetch(`${base}/`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        message: `ntfy HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
      };
    }
    return { ok: true, message: "Sent" };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function testNtfy() {
  const settings = loadNtfySettings();
  if (!settings.topic) {
    return { ok: false, message: "Save an ntfy topic first." };
  }
  const result = await sendNtfy(settings, {
    title: "Arrs Hub test",
    message:
      "ntfy is connected. You'll get alerts for new Ombi requests, stuck downloads, and services going down or coming back.",
    priority: 3,
    tags: ["white_check_mark"],
    click: settings.clickUrl || undefined,
  });
  status.lastTestAt = new Date().toISOString();
  if (!result.ok) status.lastError = result.message;
  return result;
}

// ---------------------------------------------------------------------------
// Pure diff helpers (unit-tested)
// ---------------------------------------------------------------------------

/**
 * @param {string[]} seen previously seen Ombi keys (`type:id`)
 * @param {{ id: number, type: string, title: string, requester?: string }[]} items
 * @param {boolean} primed false on first run: record everything, alert nothing
 */
export function diffOmbiPending(seen, items, primed) {
  const seenSet = new Set(seen || []);
  const fresh = [];
  for (const item of items || []) {
    const key = `${item.type}:${item.id}`;
    if (seenSet.has(key)) continue;
    seenSet.add(key);
    if (primed) fresh.push(item);
  }
  return { fresh, seen: [...seenSet].slice(-SEEN_LIMIT) };
}

/** Short label for why a queue row needs attention. */
export function queueIssueState(issue) {
  const state = String(issue?.trackedDownloadState || "").toLowerCase();
  const tracked = String(issue?.trackedDownloadStatus || "").toLowerCase();
  const status = String(issue?.status || "").toLowerCase();
  if (state === "failed" || state === "failedpending" || status === "failed") {
    return "failed";
  }
  if (state === "importpending") return "import pending";
  if (tracked === "error") return "error";
  if (tracked === "warning" || status === "warning") return "warning";
  return "needs attention";
}

/**
 * @param {string[]} seen keys `app:queueId` already alerted (or primed)
 * @param {Record<string, { ok: boolean, issues: object[] }>} queues
 * @param {string[]} primedApps apps read successfully before (first read only records)
 */
export function diffQueueIssues(seen, queues, primedApps) {
  const prev = new Set(seen || []);
  const primed = new Set(primedApps || []);
  const next = new Set();
  const fresh = [];
  for (const [app, queue] of Object.entries(queues || {})) {
    if (!queue?.ok) {
      // Keep keys for apps we couldn't read this round.
      for (const key of prev) if (key.startsWith(`${app}:`)) next.add(key);
      continue;
    }
    const alertable = primed.has(app);
    primed.add(app);
    for (const issue of queue.issues || []) {
      if (issue?.id == null) continue;
      const key = `${app}:${issue.id}`;
      next.add(key);
      if (!prev.has(key) && alertable) fresh.push({ app, issue });
    }
  }
  return {
    fresh,
    seen: [...next].slice(-SEEN_LIMIT),
    primedApps: [...primed],
  };
}

/**
 * Debounced up/down transition tracker for one service.
 * Cooldown limits "down" alerts; "up" is only sent to answer a sent "down"
 * (or a service that was already down when the Hub started).
 * @param {{ baseline?: boolean|null, pending?: { up: boolean, since: number }|null, lastDownAt?: number, lastKind?: "down"|"up"|null }} track
 * @param {boolean|null} up current Port Watch state (null = unknown, ignored)
 * @param {number} now
 * @param {{ debounceMs: number, cooldownMs: number }} opts
 * @returns {{ track: object, alert: "down"|"up"|null }}
 */
export function stepServiceTransition(track, up, now, opts) {
  const t = {
    baseline: track?.baseline ?? null,
    pending: track?.pending ?? null,
    lastDownAt: track?.lastDownAt ?? 0,
    lastKind: track?.lastKind ?? null,
  };
  if (up !== true && up !== false) return { track: t, alert: null };
  if (t.baseline === null) {
    t.baseline = up;
    t.pending = null;
    return { track: t, alert: null };
  }
  if (up === t.baseline) {
    t.pending = null;
    return { track: t, alert: null };
  }
  if (!t.pending || t.pending.up !== up) {
    t.pending = { up, since: now };
  }
  if (now - t.pending.since < opts.debounceMs) {
    return { track: t, alert: null };
  }
  t.baseline = up;
  t.pending = null;
  if (up) {
    if (t.lastKind === "up") return { track: t, alert: null };
    t.lastKind = "up";
    return { track: t, alert: "up" };
  }
  if (t.lastDownAt && now - t.lastDownAt < opts.cooldownMs) {
    return { track: t, alert: null };
  }
  t.lastDownAt = now;
  t.lastKind = "down";
  return { track: t, alert: "down" };
}

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------

const status = {
  running: false,
  lastRunAt: /** @type {string|null} */ (null),
  lastSentAt: /** @type {string|null} */ (null),
  lastTestAt: /** @type {string|null} */ (null),
  lastError: /** @type {string|null} */ (null),
};

/** @type {Map<string, ReturnType<typeof stepServiceTransition>["track"]>} */
const serviceTracks = new Map();

/** @type {ReturnType<typeof setInterval> | null} */
let timer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let firstTimer = null;
let inFlight = false;

export function getNtfyStatus() {
  const settings = loadNtfySettings();
  return {
    ...status,
    active: Boolean(settings.enabled && settings.topic),
  };
}

function loadState() {
  const raw = readJson(NTFY_STATE_PATH) || {};
  return {
    ombiPrimed: raw.ombiPrimed === true,
    ombiSeen: Array.isArray(raw.ombiSeen) ? raw.ombiSeen.map(String) : [],
    queuePrimedApps: Array.isArray(raw.queuePrimedApps)
      ? raw.queuePrimedApps.map(String)
      : [],
    queueSeen: Array.isArray(raw.queueSeen) ? raw.queueSeen.map(String) : [],
  };
}

/** Service URL is only useful as a tap target if the phone can reach it. */
function clickFor(serviceUrl, settings) {
  const host = hostnameOfUrl(serviceUrl);
  if (host && !isLoopbackHost(host)) return serviceUrl;
  return settings.clickUrl || undefined;
}

async function publish(settings, payload) {
  const result = await sendNtfy(settings, payload);
  if (result.ok) {
    status.lastSentAt = new Date().toISOString();
  } else {
    status.lastError = result.message;
    console.error("ntfy publish failed:", result.message);
  }
}

function summarizeList(lines, max = 5) {
  const shown = lines.slice(0, max);
  const extra = lines.length - shown.length;
  return extra > 0 ? `${shown.join("\n")}\n…and ${extra} more` : shown.join("\n");
}

async function checkOmbi(settings, state, resolver) {
  const result = await getOmbiPendingRequests({ resolver });
  if (!result.ok) return;
  const { fresh, seen } = diffOmbiPending(
    state.ombiSeen,
    result.items,
    state.ombiPrimed,
  );
  state.ombiSeen = seen;
  state.ombiPrimed = true;
  if (!fresh.length || !settings.events.ombiPending) return;
  const lines = fresh.map(
    (item) =>
      `${item.title} (${item.type})${item.requester ? ` — ${item.requester}` : ""}`,
  );
  const base = String(result.ombiUrl || "").replace(/\/+$/, "");
  await publish(settings, {
    title:
      fresh.length === 1
        ? "New Ombi request"
        : `${fresh.length} new Ombi requests`,
    message: summarizeList(lines),
    priority: 3,
    tags: ["inbox_tray"],
    click: clickFor(base ? `${base}/requests-list` : "", settings),
  });
}

async function checkQueues(settings, state, resolver) {
  const queues = await getArrQueues(resolver);
  const { fresh, seen, primedApps } = diffQueueIssues(
    state.queueSeen,
    queues,
    state.queuePrimedApps,
  );
  state.queueSeen = seen;
  state.queuePrimedApps = primedApps;
  if (!fresh.length || !settings.events.queueIssues) return;
  const lines = fresh.map(({ app, issue }) => {
    const label = QUEUE_APP_LABELS[app] || app;
    const why = issue.errorMessage ? `: ${issue.errorMessage.slice(0, 140)}` : "";
    return `${label} · ${issueTitle(issue)} [${queueIssueState(issue)}]${why}`;
  });
  const onlyApp = new Set(fresh.map((f) => f.app)).size === 1 ? fresh[0].app : "";
  const appUrl = onlyApp ? resolver.resolve(onlyApp) : "";
  await publish(settings, {
    title:
      fresh.length === 1
        ? `${QUEUE_APP_LABELS[fresh[0].app] || fresh[0].app}: download needs attention`
        : `${fresh.length} downloads need attention`,
    message: summarizeList(lines),
    priority: 3,
    tags: ["warning"],
    click: clickFor(
      appUrl ? `${appUrl.replace(/\/+$/, "")}/activity/queue` : "",
      settings,
    ),
  });
}

function issueTitle(issue) {
  return String(issue?.title || "Unknown item").slice(0, 120);
}

async function checkServices(settings) {
  const watch = getWatchStatus();
  const names = new Map(
    (watch.targets || []).map((t) => [String(t.id), String(t.name || t.id)]),
  );
  const urls = new Map(
    (watch.targets || []).map((t) => [String(t.id), String(t.url || "")]),
  );
  const now = Date.now();
  const opts = {
    debounceMs: settings.serviceDebounceSeconds * 1000,
    cooldownMs: settings.serviceCooldownSeconds * 1000,
  };
  for (const [id, svc] of Object.entries(watch.services || {})) {
    const { track, alert } = stepServiceTransition(
      serviceTracks.get(id),
      svc?.up ?? null,
      now,
      opts,
    );
    serviceTracks.set(id, track);
    if (!alert) continue;
    const name = names.get(id) || id;
    if (alert === "down" && settings.events.serviceDown) {
      await publish(settings, {
        title: `${name} is down`,
        message: String(svc.message || "Port Watch check failed").slice(0, 300),
        priority: 4,
        tags: ["rotating_light"],
        click: settings.clickUrl || undefined,
      });
    } else if (alert === "up" && settings.events.serviceUp) {
      await publish(settings, {
        title: `${name} is back up`,
        message: String(svc.message || "Responding again").slice(0, 300),
        priority: 3,
        tags: ["white_check_mark"],
        click: clickFor(urls.get(id) || "", settings),
      });
    }
  }
}

export async function runNtfyCycle() {
  const settings = loadNtfySettings();
  if (!settings.enabled || !settings.topic || inFlight) return;
  inFlight = true;
  status.running = true;
  try {
    const state = loadState();
    const resolver = createServiceUrlResolver({});
    const steps = [
      () => checkOmbi(settings, state, resolver),
      () => checkQueues(settings, state, resolver),
      () => checkServices(settings),
    ];
    for (const step of steps) {
      try {
        await step();
      } catch (err) {
        status.lastError = err instanceof Error ? err.message : String(err);
        console.error("ntfy check failed:", status.lastError);
      }
    }
    try {
      atomicWriteJson(NTFY_STATE_PATH, state);
    } catch (err) {
      console.error("ntfy state save failed:", err?.message || err);
    }
    status.lastRunAt = new Date().toISOString();
  } finally {
    inFlight = false;
    status.running = false;
  }
}

export function restartNtfyLoop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (firstTimer) {
    clearTimeout(firstTimer);
    firstTimer = null;
  }
  const settings = loadNtfySettings();
  if (!settings.enabled || !settings.topic) return;
  const run = () => {
    runNtfyCycle().catch((err) => {
      console.error("ntfy cycle crashed:", err?.message || err);
    });
  };
  firstTimer = setTimeout(() => {
    firstTimer = null;
    run();
  }, FIRST_RUN_DELAY_MS);
  timer = setInterval(run, Math.max(30, settings.intervalSeconds) * 1000);
}

export function startNtfyAlerts() {
  restartNtfyLoop();
}
