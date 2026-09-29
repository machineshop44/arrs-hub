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

/** @returns {{ active: Record<string, { title: string, severity: string, kind: string, firstSeen: string, misses: number }> }} */
function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    return { active: raw && typeof raw.active === "object" ? raw.active : {} };
  } catch {
    return { active: {} };
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

  return { state: { active }, added, resolved };
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
