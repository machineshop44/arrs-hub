import fs from "node:fs";
import path from "node:path";
import { RECYCLARR_DIR } from "./config.mjs";

const GUIDES_ROOT = path.join(
  RECYCLARR_DIR,
  "data",
  "resources",
  "trash-guides",
  "git",
  "official",
  "docs",
  "json",
);

/**
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {string} apiPath
 */
async function arrGet(baseUrl, apiKey, apiPath) {
  const url = `${baseUrl.replace(/\/$/, "")}${apiPath}`;
  const res = await fetch(url, {
    headers: { "X-Api-Key": apiKey },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(`${apiPath} failed (${res.status}) for ${baseUrl}`);
  }
  return res.json();
}

/**
 * Parse Recyclarr --log debug output into structured pending changes,
 * enriched with live Sonarr/Radarr data for create vs existing.
 *
 * @param {string} logText
 * @param {{
 *   sonarr?: { enabled?: boolean, baseUrl?: string, apiKey?: string },
 *   radarr?: { enabled?: boolean, baseUrl?: string, apiKey?: string },
 * }} settings
 */
export async function buildPendingChangesSummary(logText, settings) {
  const byService = {
    radarr: parseServiceBlock(logText, "radarr"),
    sonarr: parseServiceBlock(logText, "sonarr"),
  };

  const sections = [];

  for (const service of /** @type {const} */ (["radarr", "sonarr"])) {
    const block = byService[service];
    if (!block.seen) continue;

    const cfg = settings[service];
    let existingCfNames = new Set();
    let existingProfileNames = new Set();
    let apiNote = null;

    if (cfg?.enabled && cfg.baseUrl && cfg.apiKey) {
      try {
        const [cfs, profiles] = await Promise.all([
          arrGet(cfg.baseUrl, cfg.apiKey, "/api/v3/customformat"),
          arrGet(cfg.baseUrl, cfg.apiKey, "/api/v3/qualityprofile"),
        ]);
        existingCfNames = new Set(
          (cfs ?? []).map((cf) => String(cf.name || "").toLowerCase()),
        );
        existingProfileNames = new Set(
          (profiles ?? []).map((p) => String(p.name || "").toLowerCase()),
        );
      } catch (err) {
        apiNote = `Could not query ${service} for live compare: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
    }

    const createCfs = [];
    const existingCfs = [];
    for (const name of block.customFormats) {
      if (existingCfNames.has(name.toLowerCase())) existingCfs.push(name);
      else createCfs.push(name);
    }

    const profileLines = block.profiles.map((name) => {
      const exists = existingProfileNames.has(name.toLowerCase());
      return exists
        ? `Update quality profile "${name}" (already exists — scores/qualities may change)`
        : `Create quality profile "${name}"`;
    });

    const lines = [];
    lines.push(`${service.toUpperCase()}`);
    if (apiNote) lines.push(`  ! ${apiNote}`);
    for (const line of profileLines) lines.push(`  • ${line}`);

    if (createCfs.length || existingCfs.length) {
      lines.push(
        `  • Custom formats: ${createCfs.length} create, ${existingCfs.length} already present (may update)`,
      );
      if (createCfs.length) {
        lines.push(`      Create: ${formatNameList(createCfs)}`);
      }
      if (existingCfs.length && existingCfs.length <= 12) {
        lines.push(`      Existing: ${formatNameList(existingCfs)}`);
      } else if (existingCfs.length > 12) {
        lines.push(
          `      Existing: ${formatNameList(existingCfs.slice(0, 12))} (+${
            existingCfs.length - 12
          } more)`,
        );
      }
    } else {
      lines.push(`  • Custom formats: none planned`);
    }

    if (block.qualitySizes.length) {
      lines.push(
        `  • Quality sizes: ${block.qualitySizes.length} will change`,
      );
      lines.push(`      ${formatNameList(block.qualitySizes)}`);
    } else {
      lines.push(`  • Quality sizes: no changes`);
    }

    for (const group of block.cfGroups) {
      lines.push(`  • CF group (default): ${group}`);
    }

    sections.push(lines.join("\n"));
  }

  if (sections.length === 0) {
    return [
      "=== Pending changes ===",
      "No Sonarr/Radarr work was detected in the Recyclarr log.",
      "If this looks wrong, restart the hub and try Preview again.",
    ].join("\n");
  }

  return [
    "=== Pending changes (preview — nothing written) ===",
    ...sections,
    "",
    "Click Apply sync to write these changes to Sonarr/Radarr.",
  ].join("\n");
}

/**
 * @param {string} logText
 * @param {'radarr'|'sonarr'} service
 */
function parseServiceBlock(logText, service) {
  const prefix = `${service}:`;
  const customFormats = [];
  const qualitySizes = [];
  const profiles = [];
  const cfGroups = [];
  let seen = false;

  for (const rawLine of logText.split(/\r?\n/)) {
    const line = rawLine.replace(/\u001b\[[0-9;]*m/g, "");
    if (!line.includes(prefix) && !line.includes(`${service}:`)) continue;

    if (
      line.includes(`Processing Radarr server`) ||
      line.includes(`Processing Sonarr server`) ||
      line.includes(`${prefix} Processing`)
    ) {
      seen = true;
    }

    const cfMatch = line.match(
      /Process transaction for guide CF [a-f0-9]+ \((.+)\)\s*$/i,
    );
    if (cfMatch && line.includes(prefix)) {
      seen = true;
      customFormats.push(cfMatch[1].trim());
      continue;
    }

    const sizeMatch = line.match(
      /Processed Quality (.+): \[IsDifferent: True\]/i,
    );
    if (sizeMatch && line.includes(prefix)) {
      seen = true;
      qualitySizes.push(sizeMatch[1].trim());
      continue;
    }

    const profileMatch = line.match(/Pass 1: guide QP [a-f0-9]+ \((.+)\),/i);
    if (profileMatch && line.includes(prefix)) {
      seen = true;
      profiles.push(profileMatch[1].trim());
      continue;
    }

    const groupMatch = line.match(/Auto-syncing default CF group (.+) for profiles:/i);
    if (groupMatch && line.includes(prefix)) {
      seen = true;
      cfGroups.push(groupMatch[1].trim());
    }
  }

  return {
    seen,
    customFormats: unique(customFormats),
    qualitySizes: unique(qualitySizes),
    profiles: unique(profiles),
    cfGroups: unique(cfGroups),
  };
}

/** @param {string[]} names */
function formatNameList(names) {
  return names.join(", ");
}

/** @param {string[]} items */
function unique(items) {
  return [...new Set(items)];
}

/**
 * Keep UI logs readable: drop debug noise, keep INF/ERR/WARN + our summary.
 * @param {string} chunk
 */
export function filterRecyclarrLogForUi(chunk) {
  return chunk
    .split(/\r?\n/)
    .filter((line) => {
      if (!line.trim()) return true;
      if (line.includes("[DBG]")) return false;
      if (line.includes("[VRB]")) return false;
      return true;
    })
    .join("\n");
}

export function guidesAvailable() {
  return fs.existsSync(GUIDES_ROOT);
}
