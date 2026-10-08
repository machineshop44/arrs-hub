import { getArrApiKey } from "./arr-api-keys.mjs";
import { loadMonitorSettings } from "./monitor-settings.mjs";
import { arrApiVersion } from "./problems.mjs";
import { createServiceUrlResolver } from "./url-policy.mjs";

const QUEUE_APPS = new Set(["sonarr", "radarr", "lidarr", "readarr", "whisparr"]);

function squash(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** "TorrentDay, TorrentLeech" → ["torrentday", "torrentleech"] */
export function parseIndexerList(value) {
  return String(value || "")
    .split(/[,;\n]+/)
    .map(squash)
    .filter(Boolean);
}

/**
 * Private-tracker torrents must keep seeding: remove from the *arr only.
 * A torrent with no indexer name is treated as keep-seeding (can't prove it's safe).
 * @param {{ indexer?: string, protocol?: string }} item
 * @param {string} keepSeedingIndexers
 */
export function mustKeepSeeding(item, keepSeedingIndexers) {
  const list = parseIndexerList(keepSeedingIndexers);
  if (!list.length) return false;
  const indexer = squash(item?.indexer);
  if (!indexer) return String(item?.protocol || "").toLowerCase() === "torrent";
  return list.some((name) => indexer.includes(name));
}

async function fetchQueueItem(base, app, id, apiKey) {
  try {
    const res = await fetch(`${base}/api/${arrApiVersion(app)}/queue/${id}`, {
      headers: { "X-Api-Key": apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/**
 * Remove a stuck *arr queue item, optionally blocklisting the release so the
 * app searches for a different one. Keep-seeding indexers are never removed
 * from the download client.
 * @param {{ app: string, id: number, blocklist?: boolean, removeFromClient?: boolean, indexer?: string, protocol?: string, urls?: Record<string, string> }} body
 * @param {ReturnType<typeof createServiceUrlResolver>} [resolver]
 */
export async function removeArrQueueItem(body = {}, resolver) {
  const app = String(body.app || "").toLowerCase();
  const id = Number(body.id);
  if (!QUEUE_APPS.has(app)) {
    throw Object.assign(new Error("app must be sonarr, radarr, lidarr, readarr or whisparr"), { status: 400 });
  }
  if (!Number.isInteger(id) || id <= 0) {
    throw Object.assign(new Error("id must be a positive queue id"), { status: 400 });
  }
  const r = resolver || createServiceUrlResolver({ urls: body.urls || {} });
  const base = String(r.resolve(app) || "").trim().replace(/\/+$/, "");
  const apiKey = getArrApiKey(app);
  if (!base || !apiKey) {
    throw Object.assign(new Error(`${app} URL or API key is not configured`), { status: 400 });
  }
  const blocklist = body.blocklist === true;
  let removeFromClient = body.removeFromClient !== false;
  let keptSeeding = false;
  if (removeFromClient) {
    const fetched = await fetchQueueItem(base, app, id, apiKey);
    const item = fetched || { indexer: body.indexer, protocol: body.protocol };
    // A dead torrent that never downloaded anything has nothing to seed.
    const size = Number(fetched?.size) || 0;
    const nothingDownloaded =
      body.dropIfUnstarted === true && fetched != null && (size === 0 || Number(fetched.sizeleft) / size >= 0.99);
    if (!nothingDownloaded && mustKeepSeeding(item, loadMonitorSettings().keepSeedingIndexers)) {
      removeFromClient = false;
      keptSeeding = true;
    }
  }
  const qs = new URLSearchParams({
    removeFromClient: String(removeFromClient),
    blocklist: String(blocklist),
  });
  if (blocklist) qs.set("skipRedownload", String(body.skipRedownload === true));
  const res = await fetch(`${base}/api/${arrApiVersion(app)}/queue/${id}?${qs}`, {
    method: "DELETE",
    headers: { "X-Api-Key": apiKey },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw Object.assign(
      new Error(`${app} queue remove failed (HTTP ${res.status})${text ? `: ${text.slice(0, 160)}` : ""}`),
      { status: res.status === 404 ? 404 : 502 },
    );
  }
  return { ok: true, app, id, blocklist, removeFromClient, keptSeeding };
}
