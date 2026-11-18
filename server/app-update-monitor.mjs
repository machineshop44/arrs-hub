/**
 * Background auto-install of stack app updates (same paths as click-to-update).
 */
import { getChipAppVersions } from "./app-versions.mjs";
import {
  getAppUpdateJob,
  startAppUpdate,
  supportedAppUpdateIds,
} from "./app-update.mjs";
import {
  discordUsesDailyDigest,
  flushDiscordDigest,
  queueDiscordDigest,
} from "./discord-digest.mjs";
import { loadMonitorSettings } from "./monitor-settings.mjs";
import { loadWatchdogSettings } from "./watchdog-store.mjs";
import { createServiceUrlResolver } from "./url-policy.mjs";
import { sendDiscordWebhook, DISCORD_COLORS } from "./discord.mjs";

const FIRST_SCAN_DELAY_MS = 5 * 60_000;
const MAX_PER_TICK = 3;
const POLL_MS = 5_000;
/** Companion winget/UAC can sit a while; Hub click-poll is similar. */
const JOB_WAIT_MS = 12 * 60_000;

let timer = null;
let running = false;
/** @type {{ lastCheckedAt: string|null, lastError: string|null, lastResults: Array<object>, started: number, finished: number, failed: number }} */
let status = {
  lastCheckedAt: null,
  lastError: null,
  lastResults: [],
  started: 0,
  finished: 0,
  failed: 0,
};

/**
 * Pick updatable apps from a chip-versions payload.
 * @param {Awaited<ReturnType<typeof getChipAppVersions>>} versions
 * @param {string[]} [supportedIds]
 */
export function collectAutoAppUpdateCandidates(
  versions,
  supportedIds = supportedAppUpdateIds(),
) {
  const supported = new Set(supportedIds);
  /** @type {{ id: string, label: string, targetVersion: string|null, pcId: string|null }[]} */
  const out = [];
  const seen = new Set();

  const push = (row, pcId = null) => {
    const id = String(row?.id || "").trim().toLowerCase();
    if (!id || !supported.has(id) || !row?.updateAvailable || seen.has(id)) {
      return;
    }
    seen.add(id);
    out.push({
      id,
      label: String(row.label || id),
      targetVersion: row.latestVersion ? String(row.latestVersion) : null,
      pcId: pcId ? String(pcId) : null,
    });
  };

  for (const row of versions?.arrs || []) push(row);
  const companion = versions?.companion;
  if (companion?.apps?.length) {
    for (const row of companion.apps) push(row, companion.pcId || null);
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until Hub's in-memory job for this app leaves "running".
 * @param {string} appId
 * @param {number} [timeoutMs]
 */
export async function waitForAppUpdateJob(appId, timeoutMs = JOB_WAIT_MS) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const job = getAppUpdateJob(appId);
    if (!job || job.phase !== "running") return job;
    await sleep(POLL_MS);
  }
  return getAppUpdateJob(appId);
}

async function notifyAppUpdateResult(entry, settings) {
  const line = entry.ok
    ? `${entry.label}: ${entry.message || "updated"}`
    : `${entry.label}: ${entry.error || "update failed"}`;
  const webhook = String(loadWatchdogSettings().discordWebhookUrl || "").trim();

  if (discordUsesDailyDigest(settings)) {
    queueDiscordDigest("appupdate", {
      line,
      ok: entry.ok !== false,
      severity: entry.ok ? "info" : "error",
    });
    if (webhook) {
      try {
        await flushDiscordDigest(webhook, settings);
      } catch {
        /* ignore */
      }
    }
    return;
  }

  if (!webhook) return;
  try {
    await sendDiscordWebhook(webhook, {
      title: entry.ok ? "App auto-update" : "App auto-update failed",
      description: line,
      color: entry.ok ? DISCORD_COLORS.restartOk : DISCORD_COLORS.restartFail,
    });
  } catch {
    /* ignore */
  }
}

/**
 * One scheduled pass: detect yellow chips and install up to MAX_PER_TICK.
 */
export async function runAutoAppUpdatePass(opts = {}) {
  const settings = opts.settings || loadMonitorSettings();
  if (settings.autoAppUpdateEnabled === false) {
    return { skipped: true, reason: "disabled", results: [] };
  }

  const versions =
    opts.versions ||
    (await getChipAppVersions({
      resolver: opts.resolver || createServiceUrlResolver({}),
    }));
  const candidates = collectAutoAppUpdateCandidates(versions).slice(
    0,
    MAX_PER_TICK,
  );

  /** @type {Array<object>} */
  const results = [];
  for (const candidate of candidates) {
    const existing = getAppUpdateJob(candidate.id);
    if (existing?.phase === "running") {
      results.push({
        id: candidate.id,
        label: candidate.label,
        ok: false,
        skipped: true,
        error: "already running",
      });
      continue;
    }

    try {
      const startUpdate = opts.startUpdate || startAppUpdate;
      startUpdate(
        {
          id: candidate.id,
          targetVersion: candidate.targetVersion || undefined,
          pcId: candidate.pcId || undefined,
        },
        {},
      );
      status.started += 1;

      const waitJob = opts.waitForJob || waitForAppUpdateJob;
      const job = await waitJob(candidate.id);
      const ok = job?.phase === "done";
      const entry = {
        id: candidate.id,
        label: candidate.label,
        ok,
        message: job?.message || null,
        error: ok ? null : job?.error || job?.message || "update failed",
        targetVersion: candidate.targetVersion,
      };
      results.push(entry);
      if (ok) status.finished += 1;
      else status.failed += 1;
      if (!opts.silentNotify) await notifyAppUpdateResult(entry, settings);
    } catch (err) {
      const code = err?.code;
      if (code === "JOB_IN_PROGRESS") {
        results.push({
          id: candidate.id,
          label: candidate.label,
          ok: false,
          skipped: true,
          error: "already running",
        });
        continue;
      }
      const entry = {
        id: candidate.id,
        label: candidate.label,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        targetVersion: candidate.targetVersion,
      };
      results.push(entry);
      status.failed += 1;
      if (!opts.silentNotify) await notifyAppUpdateResult(entry, settings);
    }
  }

  status.lastCheckedAt = new Date().toISOString();
  status.lastError = null;
  status.lastResults = results.slice(-10);
  return { skipped: false, candidates: candidates.length, results };
}

async function tick() {
  if (running) return;
  running = true;
  try {
    await runAutoAppUpdatePass();
  } catch (err) {
    status.lastError = err instanceof Error ? err.message : String(err);
    status.lastCheckedAt = new Date().toISOString();
    console.warn("[app-update-monitor]", status.lastError);
  } finally {
    running = false;
  }
}

function scheduleNext(delayMs) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    timer = null;
    const settings = loadMonitorSettings();
    if (settings.autoAppUpdateEnabled !== false) await tick();
    const hours = Math.max(1, Number(settings.autoAppUpdateIntervalHours) || 6);
    scheduleNext(hours * 60 * 60_000);
  }, delayMs);
  timer.unref?.();
}

export function startAppUpdateMonitor() {
  scheduleNext(FIRST_SCAN_DELAY_MS);
}

export function getAppUpdateMonitorStatus() {
  return {
    ...status,
    running,
    enabled: loadMonitorSettings().autoAppUpdateEnabled !== false,
    intervalHours: loadMonitorSettings().autoAppUpdateIntervalHours,
  };
}
