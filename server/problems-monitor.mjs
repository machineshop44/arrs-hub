import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, ensureDataDirs } from "./config.mjs";
import { sendDiscordWebhook, DISCORD_COLORS } from "./discord.mjs";
import { loadMonitorSettings } from "./monitor-settings.mjs";
import { collectProblems } from "./problems.mjs";
import { loadWatchdogSettings } from "./watchdog-store.mjs";

const STATE_PATH = path.join(DATA_DIR, "problems-state.json");
/** A problem must be absent this many scans in a row before it counts as resolved. */
const RESOLVE_AFTER_MISSES = 2;
const FIRST_SCAN_DELAY_MS = 90_000;
const MAX_LINES_PER_EMBED = 15;

let timer = null;
let running = false;
/** @type {Awaited<ReturnType<typeof collectProblems>> | null} */
let lastSnapshot = null;
let lastError = null;

/**
 * `dismissed` = problems the user cleared from the dashboard chip; hidden until they resolve.
 * @returns {{ active: Record<string, { title: string, severity: string, kind: string, firstSeen: string, misses: number }>, dismissed: Record<string, { at: string, misses: number }> }}
 */
function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    return {
      active: raw && typeof raw.active === "object" && raw.active ? raw.active : {},
      dismissed: raw && typeof raw.dismissed === "object" && raw.dismissed ? raw.dismissed : {},
    };
  } catch {
    return { active: {}, dismissed: {} };
  }
}

function saveState(state) {
  ensureDataDirs();
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

function sourceOfKey(key) {
  const [kind, app] = key.split(":");
  if (kind === "disk" || kind === "vpn" || kind === "ombi") return kind;
  return `${kind}:${app}`;
}

/**
 * Diff this scan against tracked problems.
 * Exported for tests.
 */
export function diffProblems(state, problems, failedSources, now = new Date().toISOString()) {
  const failed = new Set(failedSources);
  const current = new Map(problems.map((p) => [p.key, p]));
  const active = { ...state.active };
  const added = [];
  const resolved = [];

  for (const p of problems) {
    if (active[p.key]) {
      active[p.key] = { ...active[p.key], misses: 0, title: p.title };
    } else {
      active[p.key] = {
        title: p.title,
        severity: p.severity,
        kind: p.kind,
        firstSeen: now,
        misses: 0,
      };
      added.push(p);
    }
  }

  for (const [key, entry] of Object.entries(active)) {
    if (current.has(key)) continue;
    if (failed.has(sourceOfKey(key))) continue;
    const misses = (entry.misses || 0) + 1;
    if (misses >= RESOLVE_AFTER_MISSES) {
      delete active[key];
      resolved.push({ key, ...entry });
    } else {
      active[key] = { ...entry, misses };
    }
  }

  return { state: { ...state, active }, added, resolved };
}

/**
 * Forget dismissals whose problem has been gone RESOLVE_AFTER_MISSES scans, so a
 * recurrence shows again. Only kinds covered by this scan are aged.
 * Exported for tests.
 * @param {Record<string, { at: string, misses: number }>} dismissed
 * @param {{ key: string }[]} problems
 * @param {string[]} failedSources
 * @param {string[] | null} [coveredKinds] null = every kind was scanned
 */
export function pruneDismissed(dismissed, problems, failedSources, coveredKinds = null) {
  const failed = new Set(failedSources);
  const current = new Set(problems.map((p) => p.key));
  const next = {};
  for (const [key, entry] of Object.entries(dismissed || {})) {
    const kind = key.split(":")[0];
    if (current.has(key) || failed.has(sourceOfKey(key)) || (coveredKinds && !coveredKinds.includes(kind))) {
      next[key] = { ...entry, misses: current.has(key) ? 0 : entry.misses || 0 };
      continue;
    }
    const misses = (entry.misses || 0) + 1;
    if (misses < RESOLVE_AFTER_MISSES) next[key] = { ...entry, misses };
  }
  return next;
}

/**
 * Hide dismissed problems from a snapshot and age out resolved dismissals.
 * @template {{ problems: { key: string }[], failedSources: string[] }} T
 * @param {T} snapshot
 * @param {string[] | null} [coveredKinds]
 */
export function applyDismissals(snapshot, coveredKinds = null) {
  const state = loadState();
  const dismissed = pruneDismissed(state.dismissed, snapshot.problems, snapshot.failedSources, coveredKinds);
  if (JSON.stringify(dismissed) !== JSON.stringify(state.dismissed)) {
    saveState({ ...state, dismissed });
  }
  const visible = snapshot.problems.filter((p) => !dismissed[p.key]);
  return {
    ...snapshot,
    problems: visible,
    dismissedCount: snapshot.problems.length - visible.length,
  };
}

/** @param {string[]} keys */
export function dismissProblems(keys) {
  const state = loadState();
  const now = new Date().toISOString();
  const dismissed = { ...state.dismissed };
  for (const key of keys || []) {
    const k = String(key || "").trim();
    if (k) dismissed[k] = { at: now, misses: 0 };
  }
  saveState({ ...state, dismissed });
  return Object.keys(dismissed).length;
}

export function restoreDismissedProblems() {
  const state = loadState();
  const count = Object.keys(state.dismissed).length;
  saveState({ ...state, dismissed: {} });
  return count;
}

function formatLines(items, render) {
  const lines = items.slice(0, MAX_LINES_PER_EMBED).map(render);
  if (items.length > MAX_LINES_PER_EMBED) {
    lines.push(`…and ${items.length - MAX_LINES_PER_EMBED} more (see the Hub dashboard)`);
  }
  return lines.join("\n").slice(0, 3900);
}

const SEVERITY_ICON = { error: "🔴", warning: "🟠", info: "🔵" };

async function notify(added, resolved, settings, webhookUrl) {
  if (!webhookUrl) return;
  const ombi = added.filter((p) => p.kind === "ombi");
  const issues = added.filter((p) => p.kind !== "ombi");

  if (settings.discordNotifyProblems && issues.length) {
    const worst = issues.some((p) => p.severity === "error") ? DISCORD_COLORS.down : DISCORD_COLORS.restartFail;
    await sendDiscordWebhook(webhookUrl, {
      title: issues.length === 1 ? issues[0].title : `${issues.length} new problems on your Plex stack`,
      description: formatLines(issues, (p) =>
        issues.length === 1
          ? p.detail
          : `${SEVERITY_ICON[p.severity] || "•"} **${p.title}** — ${p.detail}`,
      ),
      color: worst,
    });
  }

  if (settings.discordNotifyOmbiRequests && ombi.length) {
    await sendDiscordWebhook(webhookUrl, {
      title: ombi.length === 1 ? ombi[0].title : `${ombi.length} new Ombi requests`,
      description: formatLines(ombi, (p) =>
        ombi.length === 1 ? p.detail : `• **${p.title.replace(/^New Ombi request: /, "")}** — ${p.detail}`,
      ),
      color: DISCORD_COLORS.test,
    });
  }

  const fixed = resolved.filter((p) => p.kind !== "ombi");
  if (settings.discordNotifyProblemsResolved && fixed.length) {
    await sendDiscordWebhook(webhookUrl, {
      title: fixed.length === 1 ? `Resolved: ${fixed[0].title}` : `${fixed.length} problems resolved`,
      description: fixed.length === 1 ? undefined : formatLines(fixed, (p) => `✅ ${p.title}`),
      color: DISCORD_COLORS.restartOk,
    });
  }
}

export async function runProblemsScan() {
  if (running) return lastSnapshot;
  running = true;
  try {
    const settings = loadMonitorSettings();
    const snapshot = await collectProblems({ includeQueues: true, includeOmbi: true });
    lastSnapshot = snapshot;
    lastError = null;
    const { state, added, resolved } = diffProblems(
      loadState(),
      snapshot.problems,
      snapshot.failedSources,
    );
    saveState(state);
    applyDismissals(snapshot);
    const webhookUrl = loadWatchdogSettings().discordWebhookUrl || "";
    await notify(added, resolved, settings, webhookUrl);
    return snapshot;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    console.error("Problems scan failed:", lastError);
    return lastSnapshot;
  } finally {
    running = false;
  }
}

function scheduleNext(delayMs) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    timer = null;
    const settings = loadMonitorSettings();
    if (settings.problemsEnabled) await runProblemsScan();
    scheduleNext(Math.max(1, settings.problemsIntervalMinutes) * 60_000);
  }, delayMs);
  timer.unref?.();
}

export function startProblemsMonitor() {
  scheduleNext(FIRST_SCAN_DELAY_MS);
}

export function getProblemsMonitorStatus() {
  const state = loadState();
  return {
    lastCheckedAt: lastSnapshot?.checkedAt || null,
    lastError,
    activeCount: Object.keys(state.active).length,
  };
}
