/**
 * Shared Discord digest — queue Hub alerts and flush at most once per local day.
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, ensureDataDirs } from "./config.mjs";
import { sendDiscordWebhook, DISCORD_COLORS } from "./discord.mjs";

const DIGEST_PATH = path.join(DATA_DIR, "discord-digest.json");
const DIGEST_LIMIT = 300;
const MAX_LINES = 20;
const HOUR_MS = 60 * 60 * 1000;

/** @typedef {"problems"|"resolved"|"ombi"|"autofix"|"watchdog"|"other"} DigestSection */

function emptyDigest() {
  return { items: [], lastSentAt: null };
}

export function loadDiscordDigest() {
  ensureDataDirs();
  try {
    const raw = JSON.parse(fs.readFileSync(DIGEST_PATH, "utf8"));
    return {
      items: Array.isArray(raw?.items) ? raw.items : [],
      lastSentAt: typeof raw?.lastSentAt === "string" ? raw.lastSentAt : null,
    };
  } catch {
    return emptyDigest();
  }
}

export function saveDiscordDigest(digest) {
  ensureDataDirs();
  fs.writeFileSync(
    DIGEST_PATH,
    JSON.stringify(
      {
        items: Array.isArray(digest?.items) ? digest.items.slice(-DIGEST_LIMIT) : [],
        lastSentAt: digest?.lastSentAt || null,
      },
      null,
      2,
    ),
    "utf8",
  );
}

function startOfLocalDay(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * @param {string|null|undefined} lastSentAt
 * @param {number} digestHour
 * @param {Date|string|number} [now]
 */
export function shouldSendDiscordDigest(lastSentAt, digestHour = 9, now = new Date()) {
  const hour = Math.min(23, Math.max(0, Number(digestHour) || 9));
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const when = new Date(nowMs);
  const lastMs = lastSentAt ? Date.parse(String(lastSentAt)) : NaN;
  const sentToday =
    Number.isFinite(lastMs) && startOfLocalDay(new Date(lastMs)) === startOfLocalDay(when);
  if (sentToday) return false;
  if (when.getHours() >= hour) return true;
  return Number.isFinite(lastMs) && nowMs - lastMs >= 36 * HOUR_MS;
}

/**
 * @param {DigestSection} section
 * @param {{ line: string, severity?: string, ok?: boolean }} entry
 * @param {string} [nowIso]
 */
export function queueDiscordDigest(section, entry, nowIso = new Date().toISOString()) {
  const line = String(entry?.line || "").trim();
  if (!line) return loadDiscordDigest();
  const digest = loadDiscordDigest();
  digest.items = [
    ...(digest.items || []),
    {
      at: nowIso,
      section: String(section || "other"),
      line: line.slice(0, 400),
      severity: entry.severity || null,
      ok: entry.ok,
    },
  ].slice(-DIGEST_LIMIT);
  saveDiscordDigest(digest);
  return digest;
}

function formatSection(title, items, render) {
  if (!items.length) return "";
  const lines = items.slice(0, MAX_LINES).map(render);
  if (items.length > MAX_LINES) {
    lines.push(`…and ${items.length - MAX_LINES} more (see the Hub dashboard)`);
  }
  return `**${title}** (${items.length})\n${lines.join("\n")}`;
}

/**
 * @param {string} webhookUrl
 * @param {{ discordDigestHour?: number }} settings
 */
export async function flushDiscordDigest(webhookUrl, settings = {}) {
  const digest = loadDiscordDigest();
  const items = Array.isArray(digest.items) ? digest.items : [];
  if (!webhookUrl || !items.length) return false;
  if (!shouldSendDiscordDigest(digest.lastSentAt, settings.discordDigestHour)) {
    return false;
  }

  const by = {
    problems: items.filter((i) => i.section === "problems"),
    resolved: items.filter((i) => i.section === "resolved"),
    ombi: items.filter((i) => i.section === "ombi"),
    autofix: items.filter((i) => i.section === "autofix"),
    watchdog: items.filter((i) => i.section === "watchdog"),
    other: items.filter(
      (i) => !["problems", "resolved", "ombi", "autofix", "watchdog"].includes(i.section),
    ),
  };

  const parts = [
    formatSection("Problems", by.problems, (i) => {
      const icon = i.severity === "error" ? "🔴" : i.severity === "info" ? "🔵" : "🟠";
      return `${icon} ${i.line}`;
    }),
    formatSection("Resolved", by.resolved, (i) => `✅ ${i.line}`),
    formatSection("Ombi", by.ombi, (i) => `• ${i.line}`),
    formatSection("Auto-fixes", by.autofix, (i) => `${i.ok === false ? "⚠️" : "🧹"} ${i.line}`),
    formatSection("Watchdog", by.watchdog, (i) => `📡 ${i.line}`),
    formatSection("Other", by.other, (i) => `• ${i.line}`),
  ].filter(Boolean);

  const hasError =
    by.problems.some((i) => i.severity === "error") ||
    by.autofix.some((i) => i.ok === false) ||
    by.watchdog.some((i) => i.severity === "error");

  const result = await sendDiscordWebhook(webhookUrl, {
    title: `Daily Arrs Hub summary (${items.length} item${items.length === 1 ? "" : "s"})`,
    description: parts.join("\n\n").slice(0, 3900),
    color: hasError ? DISCORD_COLORS.restartFail : DISCORD_COLORS.restartOk,
  });

  if (!result.ok) {
    console.warn("[discord-digest]", result.message);
    return false;
  }

  saveDiscordDigest({ items: [], lastSentAt: new Date().toISOString() });
  return true;
}

/** @param {{ discordNotifyMode?: string }} settings */
export function discordUsesDailyDigest(settings = {}) {
  return String(settings.discordNotifyMode || "daily").toLowerCase() !== "immediate";
}
