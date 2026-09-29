/**
 * Which service URL the Hub may call (and attach its stored API keys to).
 *
 * Mobile / web clients send `urls` (and app-update `baseUrl`) in request
 * bodies. Those are untrusted: the Hub prefers its own configured URL, and
 * only accepts a client URL that points at loopback / LAN / a host the Hub
 * already knows. Client URLs aimed at the Hub's own public/WAN host are
 * rewritten to 127.0.0.1 (the stack runs on this PC — no router hairpin).
 */
import { loadSyncSettings } from "./config.mjs";
import { defaultSyncSettings } from "./presets.mjs";
import {
  defaultIntegrationsSettings,
  loadIntegrationsSettings,
} from "./integrations.mjs";
import { defaultTautulliSettings, loadTautulliSettings } from "./tautulli.mjs";
import { loadWatchdogSettings } from "./watchdog-store.mjs";
import { getCachedPublicIpv4, isPrivateIpv4 } from "./lan-utils.mjs";

export function normalizeServiceBase(url) {
  return String(url || "")
    .trim()
    .replace(/\/+$/, "");
}

/** Lowercase hostname without IPv6 brackets or trailing dot. */
export function normalizeHostname(host) {
  return String(host || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

/** Parse an http(s) URL; returns null for other schemes / garbage. */
export function parseHttpUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    return url;
  } catch {
    return null;
  }
}

export function hostnameOfUrl(raw) {
  const url = parseHttpUrl(raw);
  return url ? normalizeHostname(url.hostname) : "";
}

export function isLoopbackHost(host) {
  const h = normalizeHostname(host);
  if (!h) return false;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1") return true;
  return isIpv4Literal(h) && h.startsWith("127.");
}

function isIpv4Literal(h) {
  const parts = h.split(".");
  return (
    parts.length === 4 &&
    parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
  );
}

/**
 * Loopback, RFC1918, link-local (169.254/16), IPv6 ULA (fc00::/7),
 * IPv6 link-local (fe80::/10), or mDNS *.local.
 */
export function isPrivateHost(host) {
  const h = normalizeHostname(host);
  if (!h) return false;
  if (isLoopbackHost(h)) return true;
  if (h.endsWith(".local")) return true;
  if (isIpv4Literal(h)) {
    if (isPrivateIpv4(h)) return true;
    const [a, b] = h.split(".").map(Number);
    return a === 169 && b === 254;
  }
  if (h.includes(":")) {
    const first = h.split(":")[0];
    if (/^f[cd][0-9a-f]{2}$/.test(first)) return true;
    if (/^fe[89ab][0-9a-f]$/.test(first)) return true;
  }
  return false;
}

/** Hostname from the request Host header (the name/IP the caller dialed). */
export function requestHostname(req) {
  const raw = String(req?.headers?.host || "").trim();
  if (!raw) return "";
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    return normalizeHostname(end > 0 ? raw.slice(0, end + 1) : raw);
  }
  return normalizeHostname(raw.replace(/:\d+$/, ""));
}

/**
 * Vet a client-supplied service URL.
 * @param {string} clientUrl
 * @param {{ selfHosts?: string[], knownHosts?: Iterable<string> }} [opts]
 *   selfHosts: public names/IPs that reach this Hub PC (Host header, public IP)
 *   knownHosts: hostnames already present in Hub-configured service URLs
 * @returns {string} safe base URL, or "" when rejected
 */
export function sanitizeClientServiceUrl(clientUrl, opts = {}) {
  const url = parseHttpUrl(clientUrl);
  if (!url) return "";
  const host = normalizeHostname(url.hostname);
  const selfHosts = new Set(
    (opts.selfHosts || []).map(normalizeHostname).filter(Boolean),
  );
  if (selfHosts.has(host) && !isPrivateHost(host)) {
    url.hostname = "127.0.0.1";
    return normalizeServiceBase(url.toString());
  }
  if (isPrivateHost(host)) return normalizeServiceBase(url.toString());
  const known = new Set(
    [...(opts.knownHosts || [])].map(normalizeHostname).filter(Boolean),
  );
  if (known.has(host)) return normalizeServiceBase(url.toString());
  return "";
}

/**
 * Pick the URL the Hub should call for one service.
 * Hub-configured URL wins. A Hub URL still equal to its factory default
 * (e.g. qBittorrent http://localhost:8080 never edited) yields to an allowed
 * client URL, since the app may live on another LAN PC.
 * @param {{ hubUrl?: string, hubDefaultUrl?: string, clientUrl?: string, selfHosts?: string[], knownHosts?: Iterable<string> }} input
 */
export function resolveServiceUrl(input = {}) {
  const hub = parseHttpUrl(input.hubUrl)
    ? normalizeServiceBase(input.hubUrl)
    : "";
  const client = sanitizeClientServiceUrl(input.clientUrl, input);
  const hubIsDefault =
    Boolean(hub) &&
    Boolean(input.hubDefaultUrl) &&
    hub.toLowerCase() ===
      normalizeServiceBase(input.hubDefaultUrl).toLowerCase();
  if (hub && !(hubIsDefault && client)) return hub;
  return client || hub || "";
}

/**
 * Snapshot of Hub-side service URLs: explicit settings plus Port Watch
 * targets (Home mode) for apps that only store an API key on the Hub.
 */
export function loadHubServiceUrls() {
  /** @type {Record<string, string>} */
  const urls = {};
  /** @type {Record<string, string>} */
  const defaults = {};
  const knownHosts = new Set();
  const addKnown = (raw) => {
    const host = hostnameOfUrl(raw);
    if (host) knownHosts.add(host);
  };

  try {
    const watchdog = loadWatchdogSettings();
    for (const target of watchdog.targets || []) {
      const id = String(target?.id || "").trim();
      const url = String(target?.url || "").trim();
      if (!id || !parseHttpUrl(url)) continue;
      addKnown(url);
      if (target.mode !== "remote") urls[id] = normalizeServiceBase(url);
    }
    for (const pc of watchdog.pcs || []) {
      addKnown(pc?.companionUrl);
      const host = normalizeHostname(pc?.host);
      if (host) knownHosts.add(host);
    }
  } catch {
    // watchdog settings unreadable — rely on explicit settings below
  }

  try {
    const sync = loadSyncSettings();
    const syncDefaults = defaultSyncSettings();
    for (const id of ["sonarr", "radarr"]) {
      const url = normalizeServiceBase(sync[id]?.baseUrl);
      if (parseHttpUrl(url)) {
        urls[id] = url;
        defaults[id] = syncDefaults[id]?.baseUrl || "";
        addKnown(url);
      }
    }
  } catch {
    // ignore
  }

  try {
    const integrations = loadIntegrationsSettings();
    const intDefaults = defaultIntegrationsSettings();
    for (const id of ["qbittorrent", "sabnzbd", "ombi"]) {
      const url = normalizeServiceBase(integrations[id]?.baseUrl);
      if (parseHttpUrl(url)) {
        urls[id] = url;
        defaults[id] = intDefaults[id]?.baseUrl || "";
        addKnown(url);
      }
    }
  } catch {
    // ignore
  }

  try {
    const tautulli = loadTautulliSettings();
    const url = normalizeServiceBase(tautulli.baseUrl);
    if (parseHttpUrl(url)) {
      urls.tautulli = url;
      defaults.tautulli = defaultTautulliSettings().baseUrl;
      addKnown(url);
    }
  } catch {
    // ignore
  }

  return { urls, defaults, knownHosts };
}

/**
 * Build a per-request resolver.
 * @param {{ urls?: Record<string, unknown>, requestHost?: string }} [opts]
 */
export function createServiceUrlResolver(opts = {}) {
  const clientUrls =
    opts.urls && typeof opts.urls === "object" ? opts.urls : {};
  const hub = loadHubServiceUrls();
  const selfHosts = [opts.requestHost, getCachedPublicIpv4()].filter(Boolean);

  const clientRaw = (id, fallbackKey) => {
    const direct = clientUrls[id];
    if (typeof direct === "string" && direct.trim()) return direct;
    const fallback = fallbackKey ? clientUrls[fallbackKey] : "";
    return typeof fallback === "string" ? fallback : "";
  };

  return {
    /**
     * URL the Hub should call for `id` ("" = not configured / rejected).
     * @param {string} id
     * @param {{ fallbackKey?: string }} [o] extra client key (app-update baseUrl)
     */
    resolve(id, o = {}) {
      return resolveServiceUrl({
        hubUrl: hub.urls[id],
        hubDefaultUrl: hub.defaults[id],
        clientUrl: clientRaw(id, o.fallbackKey),
        selfHosts,
        knownHosts: hub.knownHosts,
      });
    },
    /**
     * URL to hand back to the client for "open in browser" links: the client's
     * own http(s) URL when it sent one (never fetched), else the resolved one.
     */
    display(id, resolved = "") {
      const raw = clientRaw(id);
      if (parseHttpUrl(raw)) return normalizeServiceBase(raw);
      return resolved || "";
    },
  };
}

/**
 * Convenience for Express handlers.
 * @param {import("express").Request} req
 */
export function serviceUrlResolverForRequest(req) {
  return createServiceUrlResolver({
    urls: req?.body?.urls,
    requestHost: requestHostname(req),
  });
}
