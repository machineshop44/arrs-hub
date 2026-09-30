import { getArrApiKey } from "./arr-api-keys.mjs";
import { getArrQueues, getOmbiPendingRequests } from "./activity.mjs";
import { loadIntegrationsSettings } from "./integrations.mjs";
import { loadMonitorSettings } from "./monitor-settings.mjs";
import { createServiceUrlResolver } from "./url-policy.mjs";

/** *arr apps with /health and /diskspace (Bazarr has neither). */
export const HEALTH_APP_IDS = [
  "sonarr",
  "radarr",
  "lidarr",
  "readarr",
  "whisparr",
  "prowlarr",
];

const APP_LABELS = {
  sonarr: "Sonarr",
  radarr: "Radarr",
  lidarr: "Lidarr",
  readarr: "Readarr",
  whisparr: "Whisparr",
  prowlarr: "Prowlarr",
  qbittorrent: "qBittorrent",
  ombi: "Ombi",
};

const GIB = 1024 ** 3;

/** Interface names that look like a VPN tunnel (Surfshark uses WireGuard/OpenVPN adapters). */
const VPN_INTERFACE_RE = /surfshark|wireguard|wintun|openvpn|tap-?windows|\btun\d*\b|\bwg\d*\b|vpn|nord|mullvad|proton|pia\b|expressvpn/i;

export function appLabel(id) {
  return APP_LABELS[id] || id;
}

function normalizeBase(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

export function arrApiVersion(id) {
  return id === "lidarr" || id === "readarr" || id === "prowlarr" ? "v1" : "v3";
}

async function getJson(url, headers = {}, timeoutMs = 8000) {
  const res = await fetch(url, {
    headers: { Accept: "application/json", ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ""}`);
  }
  return text ? JSON.parse(text) : null;
}

/**
 * *arr System → Status health checks (indexers down, missing root folder, etc.).
 * Only warning/error rows are returned; "notice" / "ok" are dropped.
 */
export async function getArrHealth(id, baseUrl, apiKey) {
  const base = normalizeBase(baseUrl);
  if (!base || !apiKey) return { id, ok: false, configured: false, items: [] };
  try {
    const data = await getJson(`${base}/api/${arrApiVersion(id)}/health`, {
      "X-Api-Key": apiKey,
    });
    const rows = Array.isArray(data) ? data : [];
    const items = rows
      .filter((row) => ["warning", "error"].includes(String(row?.type || "").toLowerCase()))
      .map((row) => ({
        type: String(row.type).toLowerCase(),
        source: String(row.source || "Health"),
        message: String(row.message || "").trim(),
        wikiUrl: typeof row.wikiUrl === "string" ? row.wikiUrl : row.wikiUrl?.fullUri || "",
      }));
    return { id, ok: true, configured: true, items };
  } catch (err) {
    return {
      id,
      ok: false,
      configured: true,
      items: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Drives the *arr app can see (root folders / all fixed drives, depending on version). */
export async function getArrDiskSpace(id, baseUrl, apiKey) {
  const base = normalizeBase(baseUrl);
  if (!base || !apiKey || id === "prowlarr") return { id, ok: false, drives: [] };
  try {
    const data = await getJson(`${base}/api/${arrApiVersion(id)}/diskspace`, {
      "X-Api-Key": apiKey,
    });
    const drives = (Array.isArray(data) ? data : [])
      .map((d) => ({
        path: String(d?.path || "").trim(),
        label: String(d?.label || "").trim(),
        freeSpace: Number(d?.freeSpace) || 0,
        totalSpace: Number(d?.totalSpace) || 0,
      }))
      .filter((d) => d.path && d.totalSpace > 0);
    return { id, ok: true, drives };
  } catch (err) {
    return {
      id,
      ok: false,
      drives: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function driveKey(p) {
  return String(p || "").trim().toLowerCase().replace(/[\\/]+$/, "");
}

function driveLetter(p) {
  const m = /^([a-z]):/i.exec(String(p || "").trim());
  return m ? `${m[1].toUpperCase()}:` : "";
}

/** "C:, D" / ["c:\\", "D:"] → ["C:", "D:"]; empty means watch every drive. */
export function parseDiskDrives(value) {
  const parts = Array.isArray(value) ? value : String(value || "").split(/[\s,;]+/);
  const letters = parts
    .map((p) => {
      const s = String(p || "").trim();
      return driveLetter(s) || (/^[a-z]$/i.test(s) ? `${s.toUpperCase()}:` : "");
    })
    .filter(Boolean);
  return [...new Set(letters)];
}

/**
 * Merge disk lists from several *arr apps (same pool shows up in each) and flag low ones.
 * With `diskDrives` set, only those letters are kept and every path on a letter
 * collapses to one entry (a DrivePool member disk is already counted in the pool).
 * @param {{ id: string, drives: { path: string, label: string, freeSpace: number, totalSpace: number }[] }[]} lists
 * @param {{ diskFreeWarnGb: number, diskMinTotalGb: number, diskDrives?: string | string[] }} thresholds
 */
export function mergeDiskSpace(lists, thresholds) {
  const allowed = parseDiskDrives(thresholds.diskDrives);
  const byPath = new Map();
  for (const list of lists) {
    for (const d of list.drives || []) {
      let key = driveKey(d.path);
      if (allowed.length) {
        const letter = driveLetter(d.path);
        if (!letter || !allowed.includes(letter)) continue;
        key = letter.toLowerCase();
        const prev = byPath.get(key);
        if (prev && driveKey(prev.path).length <= driveKey(d.path).length) continue;
        byPath.set(key, { ...d, seenBy: prev?.seenBy ?? list.id });
        continue;
      }
      if (!key || byPath.has(key)) continue;
      byPath.set(key, { ...d, seenBy: list.id });
    }
  }
  const warnBytes = Math.max(0, Number(thresholds.diskFreeWarnGb) || 0) * GIB;
  const minTotal = Math.max(0, Number(thresholds.diskMinTotalGb) || 0) * GIB;
  const drives = [...byPath.values()]
    .filter((d) => d.totalSpace >= minTotal)
    .map((d) => ({
      ...d,
      freeGb: Math.round((d.freeSpace / GIB) * 10) / 10,
      totalGb: Math.round((d.totalSpace / GIB) * 10) / 10,
      low: warnBytes > 0 && d.freeSpace < warnBytes,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return { drives, low: drives.filter((d) => d.low) };
}

async function qbLogin(base, username, password) {
  const res = await fetch(`${base}/api/v2/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: base,
    },
    body: `username=${encodeURIComponent(username || "")}&password=${encodeURIComponent(password || "")}`,
    signal: AbortSignal.timeout(8000),
  });
  const text = (await res.text()).trim().toLowerCase();
  if (!res.ok) throw new Error(`Login failed (${res.status})`);
  if (text === "fails.") throw new Error("Invalid qBittorrent username/password");
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  return cookie ? { Cookie: cookie } : {};
}

/**
 * Classify qBittorrent's bound network interface.
 * @param {{ current_network_interface?: string, current_interface_name?: string, current_interface_address?: string }} prefs
 */
export function classifyQbInterface(prefs = {}) {
  const iface = String(prefs.current_network_interface || "").trim();
  const name = String(prefs.current_interface_name || "").trim();
  const address = String(prefs.current_interface_address || "").trim();
  const display = name || iface;
  if (!iface) {
    return {
      bound: false,
      vpnLike: false,
      interfaceName: "",
      address,
      message:
        "qBittorrent is not bound to a network interface — torrents can leak outside the VPN if Surfshark drops. Set Tools → Options → Advanced → Network interface to the Surfshark adapter.",
    };
  }
  const vpnLike = VPN_INTERFACE_RE.test(`${name} ${iface}`);
  return {
    bound: true,
    vpnLike,
    interfaceName: display,
    address,
    message: vpnLike
      ? `Bound to ${display}`
      : `Bound to "${display}", which does not look like a VPN adapter.`,
  };
}

export async function getQbInterfaceStatus(baseUrl, username, password) {
  const base = normalizeBase(baseUrl);
  if (!base || (!username && !password)) return { ok: false, configured: false };
  try {
    const headers = await qbLogin(base, username, password);
    const prefs = await getJson(`${base}/api/v2/app/preferences`, headers);
    return { ok: true, configured: true, ...classifyQbInterface(prefs || {}) };
  } catch (err) {
    return {
      ok: false,
      configured: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Flatten every source into alertable problems with stable keys.
 * `failedSources` lists sources that could not be read this round, so the
 * background monitor does not treat their problems as resolved.
 */
export function buildProblemList({ health = [], disk = { low: [] }, qb = null, queues = {}, ombi = null, settings }) {
  /** @type {{ key: string, kind: string, severity: string, app: string, title: string, detail: string, url?: string }[]} */
  const problems = [];
  /** @type {string[]} */
  const failedSources = [];

  for (const h of health) {
    if (h.configured && !h.ok) failedSources.push(`health:${h.id}`);
    for (const item of h.items || []) {
      problems.push({
        key: `health:${h.id}:${item.source}`,
        kind: "health",
        severity: item.type === "error" ? "error" : "warning",
        app: h.id,
        title: `${appLabel(h.id)}: ${item.source.replace(/Check$/, "").replace(/([a-z])([A-Z])/g, "$1 $2")}`,
        detail: item.message,
        url: item.wikiUrl || undefined,
      });
    }
  }

  if (disk.failed) failedSources.push("disk");
  for (const d of disk.low || []) {
    problems.push({
      key: `disk:${driveKey(d.path)}`,
      kind: "disk",
      severity: d.freeSpace < d.totalSpace * 0.02 ? "error" : "warning",
      app: d.seenBy || "",
      title: `Low space on ${d.label ? `${d.label} (${d.path})` : d.path}`,
      detail: `${d.freeGb} GB free of ${d.totalGb} GB (alert below ${settings.diskFreeWarnGb} GB).`,
    });
  }

  if (qb?.configured) {
    if (!qb.ok) failedSources.push("vpn");
    else if (settings.qbRequireInterfaceBind && (!qb.bound || !qb.vpnLike)) {
      problems.push({
        key: "vpn:qbittorrent",
        kind: "vpn",
        severity: qb.bound ? "warning" : "error",
        app: "qbittorrent",
        title: qb.bound ? "qBittorrent bound to a non-VPN adapter" : "qBittorrent not bound to the VPN",
        detail: qb.message,
      });
    }
  }

  for (const [id, q] of Object.entries(queues)) {
    if (!q?.configured) continue;
    if (!q.ok) {
      failedSources.push(`queue:${id}`);
      continue;
    }
    for (const issue of q.issues || []) {
      problems.push({
        key: `queue:${id}:${issue.id ?? issue.title}`,
        kind: "queue",
        severity: "warning",
        app: id,
        title: `${appLabel(id)} stuck: ${issue.title}`,
        detail: issue.errorMessage || issue.trackedDownloadState || issue.status || "Needs attention",
      });
    }
  }

  if (ombi?.configured) {
    if (!ombi.ok) failedSources.push("ombi");
    for (const item of ombi.items || []) {
      problems.push({
        key: `ombi:${item.type}:${item.id}`,
        kind: "ombi",
        severity: "info",
        app: "ombi",
        title: `New Ombi request: ${item.title}`,
        detail: `${item.type === "tv" ? "TV" : item.type === "music" ? "Music" : "Movie"}${item.requester ? ` · requested by ${item.requester}` : ""}`,
      });
    }
  }

  return { problems, failedSources };
}

/**
 * Full problems snapshot (health + disk + qBit VPN bind + stuck queue + Ombi).
 * @param {{ urls?: Record<string, string>, resolver?: ReturnType<typeof createServiceUrlResolver>, includeQueues?: boolean, includeOmbi?: boolean }} [opts]
 */
export async function collectProblems(opts = {}) {
  const resolver = opts.resolver || createServiceUrlResolver({ urls: opts.urls || {} });
  const settings = loadMonitorSettings();
  const integrations = loadIntegrationsSettings();

  const targets = HEALTH_APP_IDS.map((id) => ({
    id,
    url: normalizeBase(resolver.resolve(id)),
    apiKey: getArrApiKey(id),
  }));

  const [health, diskLists, qb, queues, ombi] = await Promise.all([
    Promise.all(targets.map((t) => getArrHealth(t.id, t.url, t.apiKey))),
    Promise.all(targets.map((t) => getArrDiskSpace(t.id, t.url, t.apiKey))),
    getQbInterfaceStatus(
      normalizeBase(resolver.resolve("qbittorrent")),
      integrations.qbittorrent.username,
      integrations.qbittorrent.password,
    ),
    opts.includeQueues ? getArrQueues(resolver).catch(() => ({})) : Promise.resolve({}),
    opts.includeOmbi
      ? getOmbiPendingRequests({ resolver }).catch(() => null)
      : Promise.resolve(null),
  ]);

  const configuredDisk = diskLists.filter((l) => {
    const t = targets.find((x) => x.id === l.id);
    return l.id !== "prowlarr" && Boolean(t?.url && t?.apiKey);
  });
  const disk = {
    ...mergeDiskSpace(diskLists.filter((l) => l.ok), settings),
    failed: configuredDisk.length > 0 && configuredDisk.every((l) => !l.ok),
    thresholdGb: settings.diskFreeWarnGb,
  };

  const { problems, failedSources } = buildProblemList({
    health,
    disk,
    qb,
    queues,
    ombi,
    settings,
  });

  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    problems,
    failedSources,
    health,
    disk,
    qbittorrent: qb,
  };
}
