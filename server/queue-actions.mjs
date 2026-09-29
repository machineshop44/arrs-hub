import { getArrApiKey } from "./arr-api-keys.mjs";
import { arrApiVersion } from "./problems.mjs";
import { createServiceUrlResolver } from "./url-policy.mjs";

const QUEUE_APPS = new Set(["sonarr", "radarr", "lidarr", "readarr", "whisparr"]);

/**
 * Remove a stuck *arr queue item, optionally blocklisting the release so the
 * app searches for a different one.
 * @param {{ app: string, id: number, blocklist?: boolean, removeFromClient?: boolean, urls?: Record<string, string> }} body
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
  const removeFromClient = body.removeFromClient !== false;
  const qs = new URLSearchParams({
    removeFromClient: String(removeFromClient),
    blocklist: String(blocklist),
  });
  if (blocklist) qs.set("skipRedownload", "false");
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
  return { ok: true, app, id, blocklist, removeFromClient };
}
