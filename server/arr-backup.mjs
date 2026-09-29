import fs from "node:fs";
import path from "node:path";
import { getArrApiKey } from "./arr-api-keys.mjs";
import { DATA_DIR } from "./config.mjs";
import { sendDiscordWebhook, DISCORD_COLORS } from "./discord.mjs";
import { loadMonitorSettings, saveMonitorSettings } from "./monitor-settings.mjs";
import { HEALTH_APP_IDS, appLabel, arrApiVersion } from "./problems.mjs";
import { createServiceUrlResolver } from "./url-policy.mjs";
import { loadWatchdogSettings } from "./watchdog-store.mjs";

const CHECK_EVERY_MS = 60 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 120_000;

let timer = null;
let running = false;

export function resolveBackupDir(settings = loadMonitorSettings()) {
  return settings.backupDir || path.join(DATA_DIR, "backups");
}

function normalizeBase(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

async function arrRequest(base, apiKey, apiPath, init = {}) {
  const res = await fetch(`${base}${apiPath}`, {
    ...init,
    headers: {
      "X-Api-Key": apiKey,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    signal: AbortSignal.timeout(init.timeoutMs || 15_000),
  });
  if (!res.ok) throw new Error(`${apiPath} → HTTP ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function waitForCommand(base, apiKey, version, id) {
  const deadline = Date.now() + COMMAND_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const cmd = await arrRequest(base, apiKey, `/api/${version}/command/${id}`);
    const status = String(cmd?.status || "").toLowerCase();
    if (status === "completed") return;
    if (status === "failed" || status === "aborted" || status === "cancelled") {
      throw new Error(`Backup command ${status}${cmd?.message ? `: ${cmd.message}` : ""}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Backup command timed out");
}

/** Newest backup zips first; keep `keep`, delete the rest. */
export function pruneBackups(dir, keep) {
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".zip"))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  const removed = [];
  for (const { f } of files.slice(Math.max(1, keep))) {
    fs.unlinkSync(path.join(dir, f));
    removed.push(f);
  }
  return removed;
}

async function backupOne(id, base, apiKey, destRoot, keep) {
  const version = arrApiVersion(id);
  const cmd = await arrRequest(base, apiKey, `/api/${version}/command`, {
    method: "POST",
    body: JSON.stringify({ name: "Backup" }),
  });
  if (cmd?.id != null) await waitForCommand(base, apiKey, version, cmd.id);

  const list = await arrRequest(base, apiKey, `/api/${version}/system/backup`);
  const newest = (Array.isArray(list) ? list : [])
    .filter((b) => b?.path)
    .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())[0];
  if (!newest) throw new Error("No backups listed after running Backup");

  const sep = newest.path.includes("?") ? "&" : "?";
  const res = await fetch(`${base}${newest.path}${sep}apikey=${encodeURIComponent(apiKey)}`, {
    headers: { "X-Api-Key": apiKey },
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());

  const dir = path.join(destRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  const name = path.basename(String(newest.name || newest.path)).replace(/[^\w.\-]+/g, "_");
  const file = path.join(dir, name.toLowerCase().endsWith(".zip") ? name : `${name}.zip`);
  fs.writeFileSync(file, buf);
  pruneBackups(dir, keep);
  return { file, bytes: buf.length };
}

/** Back up every configured *arr app now. */
export async function runArrBackups() {
  if (running) throw Object.assign(new Error("A backup is already running"), { status: 409 });
  running = true;
  try {
    const settings = loadMonitorSettings();
    const destRoot = resolveBackupDir(settings);
    fs.mkdirSync(destRoot, { recursive: true });
    const resolver = createServiceUrlResolver({});
    const results = [];
    for (const id of HEALTH_APP_IDS) {
      const base = normalizeBase(resolver.resolve(id));
      const apiKey = getArrApiKey(id);
      if (!base || !apiKey) continue;
      try {
        const { file, bytes } = await backupOne(id, base, apiKey, destRoot, settings.backupKeep);
        results.push({ id, ok: true, file, bytes });
      } catch (err) {
        results.push({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    const at = new Date().toISOString();
    saveMonitorSettings({ ...loadMonitorSettings(), lastBackupAt: at, lastBackupResults: results });

    const failed = results.filter((r) => !r.ok);
    const webhookUrl = loadWatchdogSettings().discordWebhookUrl || "";
    if (failed.length && webhookUrl && settings.discordNotifyProblems) {
      await sendDiscordWebhook(webhookUrl, {
        title: `Config backup failed for ${failed.map((r) => appLabel(r.id)).join(", ")}`,
        description: failed.map((r) => `• **${appLabel(r.id)}** — ${r.error}`).join("\n"),
        color: DISCORD_COLORS.restartFail,
      });
    }
    return { ok: failed.length === 0, at, dir: destRoot, results };
  } finally {
    running = false;
  }
}

function backupDue(settings) {
  if (!settings.backupEnabled) return false;
  const last = settings.lastBackupAt ? new Date(settings.lastBackupAt).getTime() : 0;
  return !last || Date.now() - last >= settings.backupIntervalHours * 3600_000;
}

export function startBackupScheduler() {
  if (timer) clearInterval(timer);
  const tick = () => {
    if (running || !backupDue(loadMonitorSettings())) return;
    runArrBackups().catch((err) => console.error("Scheduled backup failed:", err?.message || err));
  };
  timer = setInterval(tick, CHECK_EVERY_MS);
  timer.unref?.();
  setTimeout(tick, 5 * 60_000).unref?.();
}

export function isBackupRunning() {
  return running;
}
