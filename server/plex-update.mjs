import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { DATA_DIR, ensureDataDirs } from "./config.mjs";
import { getPlexClientId, getWorkoutConfig } from "./plex.mjs";
import { normalizePlexBaseUrl } from "./workout-store.mjs";

const DOWNLOADS_JSON_URL = "https://plex.tv/api/downloads/5.json";
const CACHE_TTL_MS = 15 * 60 * 1000;
const PLEX_PRODUCT = "Arrs Hub";
export const PLEX_UPDATE_DIR = path.join(DATA_DIR, "plex-updates");

/** @type {{ fetchedAt: number, latest: string|null, downloadUrl: string|null, checksum: string|null, error: string|null } | null} */
let latestCache = null;

/**
 * @typedef {{
 *   phase: 'idle'|'checking'|'downloading'|'ready'|'installing'|'error',
 *   percent: number|null,
 *   bytesReceived: number,
 *   bytesTotal: number|null,
 *   version: string|null,
 *   filePath: string|null,
 *   error: string|null,
 *   message: string|null,
 *   startedAt: string|null,
 *   finishedAt: string|null,
 * }} DownloadState
 */

/** @type {DownloadState} */
let downloadState = idleDownloadState();

/** @type {Promise<void>|null} */
let activeDownload = null;

function idleDownloadState() {
  return {
    phase: "idle",
    percent: null,
    bytesReceived: 0,
    bytesTotal: null,
    version: null,
    filePath: null,
    error: null,
    message: null,
    startedAt: null,
    finishedAt: null,
  };
}

function ensureUpdateDir() {
  ensureDataDirs();
  fs.mkdirSync(PLEX_UPDATE_DIR, { recursive: true });
}

function plexHeaders(token, extra = {}) {
  return {
    Accept: "application/json",
    "X-Plex-Product": PLEX_PRODUCT,
    "X-Plex-Client-Identifier": getPlexClientId(),
    "X-Plex-Device-Name": PLEX_PRODUCT,
    "X-Plex-Platform": "Windows",
    "X-Plex-Device": "PC",
    ...(token ? { "X-Plex-Token": token } : {}),
    ...extra,
  };
}

/**
 * Normalize PMS version strings for comparison.
 * e.g. "1.43.3.10861-07dfddaeb" → "1.43.3.10861"
 */
export function normalizePlexVersion(version) {
  const raw = String(version || "").trim();
  if (!raw) return "";
  return raw.split("-")[0].trim();
}

/**
 * Compare dotted numeric versions. Returns -1 / 0 / 1.
 * @param {string} a
 * @param {string} b
 */
export function comparePlexVersions(a, b) {
  const left = normalizePlexVersion(a)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const right = normalizePlexVersion(b)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l < r) return -1;
    if (l > r) return 1;
  }
  return 0;
}

async function fetchInstalledVersion(baseUrl, token) {
  const url = new URL("/identity", `${normalizePlexBaseUrl(baseUrl)}/`);
  url.searchParams.set("X-Plex-Token", token);
  const res = await fetch(url, {
    headers: plexHeaders(token),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    throw new Error(
      json?.error ||
        json?.message ||
        text.slice(0, 240) ||
        `Plex /identity HTTP ${res.status}`,
    );
  }
  const container = json?.MediaContainer ?? json ?? {};
  // Fall back to root MediaContainer version if identity omits it
  if (!container.version) {
    const rootUrl = new URL("/", `${normalizePlexBaseUrl(baseUrl)}/`);
    rootUrl.searchParams.set("X-Plex-Token", token);
    const rootRes = await fetch(rootUrl, {
      headers: plexHeaders(token),
      signal: AbortSignal.timeout(15000),
    });
    const rootText = await rootRes.text();
    let rootJson = null;
    try {
      rootJson = rootText ? JSON.parse(rootText) : null;
    } catch {
      rootJson = null;
    }
    if (rootRes.ok) {
      const root = rootJson?.MediaContainer ?? rootJson ?? {};
      if (root.version) return String(root.version);
    }
  }
  return container.version ? String(container.version) : null;
}

/**
 * @param {{ force?: boolean }} [options]
 */
export async function fetchLatestPlexWindowsRelease(options = {}) {
  const force = Boolean(options.force);
  const now = Date.now();
  if (
    !force &&
    latestCache &&
    now - latestCache.fetchedAt < CACHE_TTL_MS &&
    latestCache.latest
  ) {
    return latestCache;
  }

  try {
    const res = await fetch(DOWNLOADS_JSON_URL, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Arrs-Hub",
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      throw new Error(`plex.tv downloads HTTP ${res.status}`);
    }
    const json = await res.json();
    const windows = json?.computer?.Windows;
    const version = String(windows?.version || "").trim() || null;
    const releases = Array.isArray(windows?.releases) ? windows.releases : [];
    const x64 =
      releases.find(
        (item) =>
          String(item?.build || "").toLowerCase() === "windows-x86_64" ||
          String(item?.url || "").includes("x86_64"),
      ) ||
      releases.find((item) =>
        String(item?.url || "").toLowerCase().endsWith(".exe"),
      );
    const downloadUrl = x64?.url ? String(x64.url) : null;
    const checksum = x64?.checksum ? String(x64.checksum) : null;
    if (!version || !downloadUrl) {
      throw new Error("Could not find Windows x64 Plex Media Server download.");
    }
    latestCache = {
      fetchedAt: now,
      latest: version,
      downloadUrl,
      checksum,
      error: null,
    };
    return latestCache;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (latestCache?.latest && latestCache.downloadUrl) {
      return {
        ...latestCache,
        error: `Using cached latest (${message})`,
      };
    }
    latestCache = {
      fetchedAt: now,
      latest: null,
      downloadUrl: null,
      checksum: null,
      error: message,
    };
    return latestCache;
  }
}

/**
 * @param {{ forceLatest?: boolean, refresh?: boolean }} [options]
 */
export async function getPlexUpdateStatus(options = {}) {
  const settings = getWorkoutConfig();
  const tokenSet = Boolean(settings.plexToken?.trim());
  const plexBaseUrl = settings.plexBaseUrl;

  /** @type {string|null} */
  let installed = null;
  /** @type {string|null} */
  let installedError = null;

  if (!tokenSet) {
    installedError =
      "Sign in with Plex in Workouts (or save a Plex token) so Arrs Hub can read your server version.";
  } else {
    try {
      installed = await fetchInstalledVersion(
        plexBaseUrl,
        settings.plexToken.trim(),
      );
      if (!installed) {
        installedError = "Plex responded but did not include a version.";
      }
    } catch (err) {
      installedError = err instanceof Error ? err.message : String(err);
    }
  }

  const latestInfo = await fetchLatestPlexWindowsRelease({
    force: Boolean(options.forceLatest || options.refresh),
  });

  const latest = latestInfo.latest;
  const updateAvailable =
    Boolean(installed && latest) &&
    comparePlexVersions(installed, latest) < 0;

  const readyFile =
    downloadState.phase === "ready" &&
    downloadState.filePath &&
    fs.existsSync(downloadState.filePath)
      ? downloadState.filePath
      : null;

  return {
    ok: true,
    signedIn: tokenSet,
    plexBaseUrl,
    installed,
    installedVersion: installed,
    installedError,
    latest,
    latestVersion: latest,
    latestError: latestInfo.error,
    downloadUrl: latestInfo.downloadUrl,
    checksum: latestInfo.checksum,
    updateAvailable,
    download: { ...downloadState, filePath: readyFile || downloadState.filePath },
    hint: !tokenSet
      ? "Open Workouts → Sign in with Plex, and set Plex base URL (usually http://localhost:32400)."
      : installedError
        ? `Plex Media Server unreachable at ${plexBaseUrl}. Is PMS running?`
        : null,
  };
}

function installerFileName(version) {
  const safe =
    normalizePlexVersion(version).replace(/[^\w.-]+/g, "_") || "latest";
  return `PlexMediaServer-${safe}-x86_64.exe`;
}

/**
 * @param {{ version?: string|null, downloadUrl?: string|null }} [options]
 */
export async function startPlexInstallerDownload(options = {}) {
  if (activeDownload || downloadState.phase === "downloading") {
    return { ...downloadState, alreadyRunning: true };
  }

  const latestInfo = await fetchLatestPlexWindowsRelease({ force: false });
  const version = options.version || latestInfo.latest;
  const downloadUrl = options.downloadUrl || latestInfo.downloadUrl;
  if (!version || !downloadUrl) {
    throw new Error(
      latestInfo.error ||
        "Could not resolve latest Plex Media Server download.",
    );
  }

  ensureUpdateDir();
  const filePath = path.join(PLEX_UPDATE_DIR, installerFileName(version));

  downloadState = {
    phase: "downloading",
    percent: 0,
    bytesReceived: 0,
    bytesTotal: null,
    version,
    filePath,
    error: null,
    message: "Downloading Plex Media Server installer…",
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };

  activeDownload = (async () => {
    const partialPath = `${filePath}.partial`;
    try {
      if (fs.existsSync(filePath)) {
        downloadState = {
          ...downloadState,
          phase: "ready",
          percent: 100,
          message: "Installer already downloaded.",
          finishedAt: new Date().toISOString(),
        };
        return;
      }

      const res = await fetch(downloadUrl, {
        headers: { "User-Agent": "Arrs-Hub" },
        redirect: "follow",
      });
      if (!res.ok || !res.body) {
        throw new Error(`Download failed (HTTP ${res.status})`);
      }

      const totalHeader = res.headers.get("content-length");
      const bytesTotal = totalHeader ? Number(totalHeader) : null;
      downloadState.bytesTotal =
        Number.isFinite(bytesTotal) && bytesTotal > 0 ? bytesTotal : null;

      let received = 0;
      const nodeStream = Readable.fromWeb(res.body);
      nodeStream.on("data", (chunk) => {
        received += chunk.length;
        const percent =
          downloadState.bytesTotal && downloadState.bytesTotal > 0
            ? Math.min(
                99,
                Math.round((received / downloadState.bytesTotal) * 100),
              )
            : null;
        downloadState = {
          ...downloadState,
          bytesReceived: received,
          percent,
          message:
            percent != null
              ? `Downloading… ${percent}%`
              : `Downloading… ${(received / (1024 * 1024)).toFixed(1)} MB`,
        };
      });

      await pipeline(nodeStream, createWriteStream(partialPath));
      fs.renameSync(partialPath, filePath);

      downloadState = {
        ...downloadState,
        phase: "ready",
        percent: 100,
        bytesReceived: received,
        filePath,
        message: "Download complete. Ready to install.",
        finishedAt: new Date().toISOString(),
      };
    } catch (err) {
      try {
        if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath);
      } catch {
        // ignore cleanup errors
      }
      const message = err instanceof Error ? err.message : String(err);
      downloadState = {
        ...downloadState,
        phase: "error",
        error: message,
        message: `Download failed: ${message}`,
        finishedAt: new Date().toISOString(),
      };
    } finally {
      activeDownload = null;
    }
  })();

  void activeDownload;
  return { ...downloadState, alreadyRunning: false };
}

/**
 * Launch the downloaded (or freshly downloaded) PMS Windows installer.
 * Default is interactive so the user sees Plex's wizard + UAC.
 * @param {{ silent?: boolean, downloadIfNeeded?: boolean }} [options]
 */
export async function installPlexUpdate(options = {}) {
  const silent = Boolean(options.silent);
  const downloadIfNeeded = options.downloadIfNeeded !== false;

  let filePath =
    downloadState.filePath && fs.existsSync(downloadState.filePath)
      ? downloadState.filePath
      : null;

  if (!filePath && downloadIfNeeded) {
    await startPlexInstallerDownload();
    if (activeDownload) await activeDownload;
    if (downloadState.phase === "error") {
      throw new Error(downloadState.error || "Download failed.");
    }
    filePath = downloadState.filePath;
  }

  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(
      "No installer on disk. Use Download first, or Download & install.",
    );
  }

  downloadState = {
    ...downloadState,
    phase: "installing",
    message: silent
      ? "Launching silent Plex installer (UAC may still appear)…"
      : "Launching Plex installer — complete the wizard; Windows may prompt for UAC.",
    error: null,
    startedAt: downloadState.startedAt || new Date().toISOString(),
  };

  const args = silent ? ["/quiet"] : [];

  await new Promise((resolve, reject) => {
    try {
      const child = spawn(filePath, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
        shell: false,
      });
      child.on("error", reject);
      child.unref();
      setTimeout(resolve, 250);
    } catch (err) {
      reject(err);
    }
  });

  downloadState = {
    ...downloadState,
    phase: "ready",
    message: silent
      ? "Silent installer launched. Arrs Hub cannot confirm when Plex finishes upgrading."
      : "Installer launched. Finish Plex’s wizard (UAC may appear). Arrs Hub cannot silently complete their install.",
    finishedAt: new Date().toISOString(),
  };

  return {
    ok: true,
    filePath,
    silent,
    download: { ...downloadState },
  };
}

/**
 * Download (if needed) then launch installer.
 * @param {{ silent?: boolean }} [options]
 */
export async function downloadAndInstallPlexUpdate(options = {}) {
  await startPlexInstallerDownload();
  if (activeDownload) await activeDownload;
  if (downloadState.phase === "error") {
    throw new Error(downloadState.error || "Download failed.");
  }
  return installPlexUpdate({
    silent: Boolean(options.silent),
    downloadIfNeeded: false,
  });
}

export function getPlexDownloadState() {
  return { ...downloadState };
}
