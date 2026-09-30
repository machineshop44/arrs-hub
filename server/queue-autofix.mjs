import { appLabel } from "./problems.mjs";
import { removeArrQueueItem } from "./queue-actions.mjs";

/** Extensions that never belong in a media release. */
const DANGEROUS_EXT = /\.(exe|lnk|scr|bat|cmd|vbs|vbe|msi|pif|ps1|jar|arj|hta|wsf)\b/i;
const DANGEROUS_MSG = /dangerous|unwanted (file )?extension|executable/i;
const SAMPLE_MSG = /\bsample\b|no files found (are )?eligible|no (video|audio|media) files/i;
const NOT_UPGRADE_MSG =
  /not an upgrade|not a custom format upgrade|already imported|existing file .*(better|same)|has a (better|same) (quality|custom format)|already (exists|has a file)/i;

/**
 * Pick the auto-fix for a stuck queue item, or null when a human should look
 * (manual import / unparseable / unmatched series).
 * @param {{ errorMessage?: string, status?: string, trackedDownloadState?: string }} issue
 * @param {Record<string, unknown>} settings monitor settings
 * @returns {{ rule: "dangerous" | "sample" | "notUpgrade" | "failed", blocklist: boolean, reason: string } | null}
 */
export function classifyQueueIssue(issue, settings) {
  const msg = String(issue?.errorMessage || "");
  const state = String(issue?.trackedDownloadState || "").toLowerCase();
  const status = String(issue?.status || "").toLowerCase();

  if (settings.autoFixDangerous !== false && (DANGEROUS_MSG.test(msg) || DANGEROUS_EXT.test(msg))) {
    const ext = DANGEROUS_EXT.exec(msg)?.[0]?.toLowerCase();
    return { rule: "dangerous", blocklist: true, reason: `unwanted file${ext ? ` (${ext})` : ""}` };
  }
  if (settings.autoFixSample !== false && SAMPLE_MSG.test(msg)) {
    return { rule: "sample", blocklist: true, reason: "sample / no importable files" };
  }
  if (settings.autoFixNotUpgrade !== false && NOT_UPGRADE_MSG.test(msg)) {
    return { rule: "notUpgrade", blocklist: false, reason: "not an upgrade / already imported" };
  }
  if (
    settings.autoFixFailed !== false &&
    (state === "failed" || state === "failedpending" || status === "failed")
  ) {
    return { rule: "failed", blocklist: true, reason: "download failed" };
  }
  return null;
}

/** Skip an item for this long after a failed fix attempt. */
const RETRY_AFTER_MS = 60 * 60 * 1000;
/** @type {Map<string, number>} */
const failedAt = new Map();

/**
 * Apply auto-fix rules to the queues from a problems snapshot.
 * @param {Record<string, { ok?: boolean, issues?: object[] }>} queues
 * @param {Record<string, unknown>} settings
 * @param {{ remove?: typeof removeArrQueueItem, now?: number }} [deps]
 * @returns {Promise<{ key: string, app: string, title: string, rule: string, reason: string, blocklist: boolean, keptSeeding: boolean, ok: boolean, error?: string, at: string }[]>}
 */
export async function runQueueAutoFix(queues, settings, deps = {}) {
  if (settings.autoFixEnabled === false) return [];
  const remove = deps.remove || removeArrQueueItem;
  const now = deps.now ?? Date.now();
  const max = Math.max(1, Number(settings.autoFixMaxPerScan) || 10);
  const results = [];

  for (const [app, q] of Object.entries(queues || {})) {
    if (!q?.ok) continue;
    for (const issue of q.issues || []) {
      if (results.length >= max) return results;
      const id = Number(issue?.id);
      if (!Number.isInteger(id) || id <= 0) continue;
      const key = `queue:${app}:${id}`;
      const lastFail = failedAt.get(key);
      if (lastFail != null && now - lastFail < RETRY_AFTER_MS) continue;
      const fix = classifyQueueIssue(issue, settings);
      if (!fix) continue;

      const base = {
        key,
        app,
        title: String(issue.title || "Unknown item"),
        rule: fix.rule,
        reason: fix.reason,
        blocklist: fix.blocklist,
        at: new Date(now).toISOString(),
      };
      try {
        const r = await remove({
          app,
          id,
          blocklist: fix.blocklist,
          removeFromClient: true,
          indexer: issue.indexer,
          protocol: issue.protocol,
        });
        failedAt.delete(key);
        results.push({ ...base, keptSeeding: Boolean(r?.keptSeeding), ok: true });
      } catch (err) {
        failedAt.set(key, now);
        results.push({
          ...base,
          keptSeeding: false,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return results;
}

export function describeAutoFix(r) {
  const action = r.blocklist ? "blocklisted, searching again" : "removed";
  const seed = r.keptSeeding ? " · still seeding in qBittorrent" : "";
  const status = r.ok ? `${action}${seed}` : `fix failed: ${r.error}`;
  return `${appLabel(r.app)}: ${r.title} — ${r.reason} → ${status}`;
}
