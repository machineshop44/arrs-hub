/**
 * Remote photo/video dump: authenticated upload into a root folder on the Hub PC.
 * Mobile browses/creates subfolders under rootPath only (e.g. N:\PhoneDump).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
import { DATA_DIR, ensureDataDirs } from "./config.mjs";
import {
  detectPublicIpv4,
  isPrivateIpv4,
  pickPrimaryLanIpv4,
} from "./lan-utils.mjs";

export const PHOTO_DUMP_SETTINGS_PATH = path.join(
  DATA_DIR,
  "photo-dump-settings.json",
);

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
const MIN_FREE_BYTES = 256 * 1024 * 1024; // refuse upload if less free space
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_UPLOADS = 60;
const DAILY_BYTE_QUOTA = 40 * 1024 * 1024 * 1024; // 40 GiB / key / day

const WIN_RESERVED = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

/** @type {Map<string, { windowStart: number, count: number, dayKey: string, dayBytes: number }>} */
const uploadQuotaByKey = new Map();

function pickSecret(incoming, current) {
  if (typeof incoming !== "string") return current;
  const trimmed = incoming.trim();
  if (!trimmed) return current;
  if (trimmed.includes("…") || trimmed.includes("•")) return current;
  return trimmed;
}

function maskKey(key) {
  if (!key) return "";
  if (key.length <= 8) return "••••••••";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function randomApiKey() {
  return crypto.randomBytes(24).toString("hex");
}

function isWindowsReservedBase(name) {
  const stem = String(name || "")
    .split(".")[0]
    .toUpperCase();
  return WIN_RESERVED.has(stem);
}

function assertSafePathSegment(part) {
  if (part === "." || part === "..") {
    throw new Error("Invalid folder path.");
  }
  if (/[<>:"|?*\u0000-\u001f]/.test(part)) {
    throw new Error(`Invalid folder name: ${part}`);
  }
  if (/[. ]$/.test(part)) {
    throw new Error(`Invalid folder name (trailing dot/space): ${part}`);
  }
  if (isWindowsReservedBase(part)) {
    throw new Error(`Reserved Windows name not allowed: ${part}`);
  }
}

/**
 * Require an absolute filesystem path (Windows drive or UNC).
 * @param {string} raw
 */
export function assertAbsoluteRootPath(raw) {
  const rootPath = String(raw || "").trim();
  if (!rootPath) throw new Error("Photo dump root path is required.");
  if (rootPath.includes("\0")) throw new Error("Invalid root path.");
  if (/[<>"|?*]/.test(rootPath)) {
    throw new Error("Root path contains invalid characters.");
  }
  // Reject relative / traversal-looking roots.
  if (rootPath.includes("..")) {
    throw new Error("Root path must not contain '..'.");
  }
  if (!path.isAbsolute(rootPath)) {
    throw new Error("Root path must be absolute (e.g. N:\\PhoneDump).");
  }
  const resolved = path.resolve(rootPath);
  if (!path.isAbsolute(resolved)) {
    throw new Error("Root path must be absolute (e.g. N:\\PhoneDump).");
  }
  return resolved;
}

export function defaultPhotoDumpSettings() {
  return {
    enabled: true,
    /** Absolute Windows path — uploads stay under this tree only. */
    rootPath: "N:\\PhoneDump",
    apiKey: "",
    maxFileBytes: DEFAULT_MAX_BYTES,
    /** Saved Hub base URL baked into Mobile setup QR (LAN or WAN). */
    pairUrl: "",
    /** Prefer detected public/WAN IP in QR when pairUrl is empty. */
    preferPublicPairUrl: true,
  };
}

function atomicWriteJson(filePath, value) {
  ensureDataDirs();
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}

export function loadPhotoDumpSettings() {
  ensureDataDirs();
  if (!fs.existsSync(PHOTO_DUMP_SETTINGS_PATH)) {
    const defaults = defaultPhotoDumpSettings();
    savePhotoDumpSettings(defaults);
    return defaults;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(PHOTO_DUMP_SETTINGS_PATH, "utf8"));
    const defaults = defaultPhotoDumpSettings();
    let rootPath = String(raw.rootPath || defaults.rootPath).trim() || defaults.rootPath;
    try {
      rootPath = assertAbsoluteRootPath(rootPath);
    } catch {
      rootPath = defaults.rootPath;
    }
    return {
      ...defaults,
      ...raw,
      rootPath,
      apiKey: typeof raw.apiKey === "string" ? raw.apiKey : "",
      maxFileBytes: Math.max(
        1_000_000,
        Number(raw.maxFileBytes) || defaults.maxFileBytes,
      ),
      enabled: raw.enabled !== false,
      pairUrl: typeof raw.pairUrl === "string" ? raw.pairUrl.trim() : "",
      preferPublicPairUrl: raw.preferPublicPairUrl !== false,
    };
  } catch {
    return defaultPhotoDumpSettings();
  }
}

export function savePhotoDumpSettings(settings) {
  atomicWriteJson(PHOTO_DUMP_SETTINGS_PATH, settings);
  return settings;
}

/** Full settings for Hub UI (local) or key-authenticated Mobile. */
export function publicPhotoDumpSettings(settings = loadPhotoDumpSettings()) {
  return {
    enabled: settings.enabled !== false,
    rootPath: settings.rootPath || "",
    rootPathSet: Boolean(String(settings.rootPath || "").trim()),
    apiKey: settings.apiKey ? maskKey(settings.apiKey) : "",
    apiKeySet: Boolean(String(settings.apiKey || "").trim()),
    maxFileBytes: settings.maxFileBytes || DEFAULT_MAX_BYTES,
  };
}

/** Minimal unauthenticated status for remote probes (no path / key leak). */
export function publicPhotoDumpStatus(settings = loadPhotoDumpSettings()) {
  return {
    enabled: settings.enabled !== false,
    rootPathSet: Boolean(String(settings.rootPath || "").trim()),
    apiKeySet: Boolean(String(settings.apiKey || "").trim()),
    maxFileBytes: settings.maxFileBytes || DEFAULT_MAX_BYTES,
  };
}

/**
 * @param {Record<string, unknown>} patch
 * @param {{ rotateKey?: boolean }} [opts]
 */
export function updatePhotoDumpSettings(patch = {}, opts = {}) {
  const current = loadPhotoDumpSettings();
  let apiKey = pickSecret(patch.apiKey, current.apiKey);
  if (opts.rotateKey || patch.rotateKey === true) {
    apiKey = randomApiKey();
  }
  const nextRoot =
    patch.rootPath !== undefined
      ? assertAbsoluteRootPath(String(patch.rootPath || "").trim() || current.rootPath)
      : assertAbsoluteRootPath(current.rootPath);
  const next = {
    enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : current.enabled,
    rootPath: nextRoot,
    apiKey,
    maxFileBytes:
      patch.maxFileBytes !== undefined
        ? Math.max(1_000_000, Number(patch.maxFileBytes) || current.maxFileBytes)
        : current.maxFileBytes,
    pairUrl:
      patch.pairUrl !== undefined
        ? String(patch.pairUrl || "").trim().replace(/\/+$/, "")
        : current.pairUrl || "",
    preferPublicPairUrl:
      patch.preferPublicPairUrl !== undefined
        ? Boolean(patch.preferPublicPairUrl)
        : current.preferPublicPairUrl !== false,
  };
  return savePhotoDumpSettings(next);
}

export function verifyPhotoDumpApiKey(provided) {
  const settings = loadPhotoDumpSettings();
  const expected = String(settings.apiKey || "").trim();
  if (!expected) return false;
  const got = String(provided || "").trim();
  if (!got) return false;
  const a = crypto.createHash("sha256").update(got, "utf8").digest();
  const b = crypto.createHash("sha256").update(expected, "utf8").digest();
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function assertPhotoDumpEnabled(settings = loadPhotoDumpSettings()) {
  if (settings.enabled === false) {
    throw new Error("Photo dump is disabled on the Hub.");
  }
  return settings;
}

/** Normalize relative folder path ("" = root). Rejects traversal. */
export function normalizeRelativeFolder(raw) {
  let rel = String(raw || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .trim();
  if (!rel || rel === ".") return "";
  const parts = rel.split("/").filter(Boolean);
  for (const part of parts) {
    assertSafePathSegment(part);
  }
  return parts.join(path.sep);
}

function realPathSafe(p) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export function resolveUnderRoot(rootPath, relativeFolder = "") {
  const root = assertAbsoluteRootPath(rootPath);
  const rel = normalizeRelativeFolder(relativeFolder);
  const target = rel ? path.resolve(root, rel) : root;
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (target !== root && !target.startsWith(rootWithSep)) {
    throw new Error("Path escapes photo dump root.");
  }
  return { root, relative: rel, absolute: target };
}

/**
 * Resolve and ensure the folder exists; re-check realpath stays under root.
 */
function resolveWritableFolder(rootPath, relativeFolder = "") {
  const { root, relative, absolute } = resolveUnderRoot(rootPath, relativeFolder);
  fs.mkdirSync(absolute, { recursive: true });
  const realRoot = realPathSafe(root);
  const realTarget = realPathSafe(absolute);
  const rootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  if (realTarget !== realRoot && !realTarget.startsWith(rootWithSep)) {
    throw new Error("Path escapes photo dump root (symlink/junction).");
  }
  return { root: realRoot, relative, absolute: realTarget };
}

function safeFileName(name) {
  let base = path.basename(String(name || "upload.bin")).trim() || "upload.bin";
  base = base.replace(/[<>:"|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "");
  if (!base) base = "upload.bin";
  if (isWindowsReservedBase(base)) {
    base = `file-${base}`;
  }
  return base.slice(0, 180) || "upload.bin";
}

/**
 * Move temp → final with exclusive create so two uploads cannot clobber.
 */
function finalizeUniqueDest(tmp, folderAbs, originalName) {
  const baseName = safeFileName(originalName);
  const ext = path.extname(baseName);
  const stem = path.basename(baseName, ext);
  for (let i = 0; i < 32; i += 1) {
    const fileName =
      i === 0
        ? baseName
        : `${stem}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}${ext}`;
    const dest = path.join(folderAbs, fileName);
    try {
      fs.copyFileSync(tmp, dest, fs.constants.COPYFILE_EXCL);
      try {
        fs.unlinkSync(tmp);
      } catch {
        // ignore
      }
      return { fileName, dest };
    } catch (err) {
      if (err && err.code === "EEXIST") continue;
      throw err;
    }
  }
  throw new Error("Could not allocate a unique file name.");
}

export function ensureRootExists(rootPath) {
  const root = assertAbsoluteRootPath(rootPath);
  fs.mkdirSync(root, { recursive: true });
  return realPathSafe(root);
}

function assertEnoughFreeSpace(dirPath, needBytes) {
  try {
    if (typeof fs.statfsSync !== "function") return;
    const st = fs.statfsSync(dirPath);
    const free = Number(st.bavail) * Number(st.bsize);
    if (!Number.isFinite(free)) return;
    if (free < Math.max(MIN_FREE_BYTES, needBytes + MIN_FREE_BYTES)) {
      throw new Error("Not enough free disk space on the photo dump volume.");
    }
  } catch (err) {
    if (err instanceof Error && /Not enough free/.test(err.message)) throw err;
    // Unsupported platforms / network mounts — skip.
  }
}

function assertUploadQuota(apiKey, expectedSize) {
  const keyHash = crypto
    .createHash("sha256")
    .update(String(apiKey || ""), "utf8")
    .digest("hex")
    .slice(0, 16);
  const now = Date.now();
  const dayKey = new Date().toISOString().slice(0, 10);
  let entry = uploadQuotaByKey.get(keyHash);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    entry = {
      windowStart: now,
      count: 0,
      dayKey: entry?.dayKey === dayKey ? entry.dayKey : dayKey,
      dayBytes: entry?.dayKey === dayKey ? entry.dayBytes : 0,
    };
  }
  if (entry.dayKey !== dayKey) {
    entry.dayKey = dayKey;
    entry.dayBytes = 0;
  }
  if (entry.count >= RATE_MAX_UPLOADS) {
    throw new Error("Upload rate limit exceeded — try again in a minute.");
  }
  const size = Math.max(0, Number(expectedSize) || 0);
  if (entry.dayBytes + size > DAILY_BYTE_QUOTA) {
    throw new Error("Daily photo dump quota exceeded on the Hub.");
  }
  entry.count += 1;
  entry.dayBytes += size;
  uploadQuotaByKey.set(keyHash, entry);
  return { keyHash, reservedBytes: size };
}

/** Refund reserved quota when an upload fails after assertUploadQuota. */
function refundUploadQuota(apiKey, reservedBytes) {
  const keyHash = crypto
    .createHash("sha256")
    .update(String(apiKey || ""), "utf8")
    .digest("hex")
    .slice(0, 16);
  const entry = uploadQuotaByKey.get(keyHash);
  if (!entry) return;
  entry.count = Math.max(0, (entry.count || 0) - 1);
  entry.dayBytes = Math.max(
    0,
    (entry.dayBytes || 0) - Math.max(0, Number(reservedBytes) || 0),
  );
  uploadQuotaByKey.set(keyHash, entry);
}

/**
 * List immediate child folders under root/relativeFolder.
 */
export function listPhotoDumpFolders(relativeFolder = "") {
  const settings = assertPhotoDumpEnabled();
  ensureRootExists(settings.rootPath);
  const { absolute, relative } = resolveWritableFolder(
    settings.rootPath,
    relativeFolder,
  );
  const entries = fs.readdirSync(absolute, { withFileTypes: true });
  const folders = entries
    .filter(
      (e) =>
        e.isDirectory() &&
        !isWindowsReservedBase(e.name) &&
        e.name !== SHA_INDEX_NAME &&
        !e.name.startsWith(".arrs-hub-"),
    )
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  return {
    path: relative.replace(/\\/g, "/"),
    folders,
  };
}

/**
 * Create a folder under root (relative path, may include nested segments).
 */
export function createPhotoDumpFolder(relativeFolder) {
  const settings = assertPhotoDumpEnabled();
  const rel = normalizeRelativeFolder(relativeFolder);
  if (!rel) throw new Error("Folder name is required.");
  ensureRootExists(settings.rootPath);
  const { absolute, relative } = resolveWritableFolder(settings.rootPath, rel);
  return {
    path: relative.replace(/\\/g, "/"),
  };
}

const SHA_INDEX_NAME = ".arrs-hub-sha-index.json";

function shaIndexPath(rootPath) {
  return path.join(assertAbsoluteRootPath(rootPath), SHA_INDEX_NAME);
}

function loadShaIndex(rootPath) {
  const file = shaIndexPath(rootPath);
  try {
    if (!fs.existsSync(file)) {
      return { version: 1, entries: {} };
    }
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const entries =
      raw && typeof raw.entries === "object" && raw.entries
        ? raw.entries
        : {};
    return { version: 1, entries };
  } catch {
    return { version: 1, entries: {} };
  }
}

function saveShaIndex(rootPath, index) {
  const root = assertAbsoluteRootPath(rootPath);
  ensureRootExists(root);
  const file = shaIndexPath(root);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(
    tmp,
    `${JSON.stringify({ version: 1, entries: index.entries || {} }, null, 2)}\n`,
    "utf8",
  );
  fs.renameSync(tmp, file);
}

/**
 * Look up an existing verified file by SHA-256 under the dump root.
 * @returns {{ path: string, fileName: string, folder: string, size: number, sha256: string } | null}
 */
export function findPhotoDumpBySha(rootPath, sha256) {
  const sha = String(sha256 || "")
    .trim()
    .toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha)) return null;

  const root = assertAbsoluteRootPath(rootPath);
  ensureRootExists(root);
  const index = loadShaIndex(root);
  const entry = index.entries[sha];
  if (!entry || typeof entry.path !== "string" || !entry.path.trim()) {
    return null;
  }

  const relPath = String(entry.path || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .trim();
  if (!relPath || relPath.split("/").some((p) => p === ".." || p === ".")) {
    return null;
  }

  const absolute = path.resolve(root, relPath.split("/").join(path.sep));
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (absolute !== root && !absolute.startsWith(rootWithSep)) {
    return null;
  }

  try {
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      delete index.entries[sha];
      saveShaIndex(root, index);
      return null;
    }
    const st = fs.statSync(absolute);
    if (
      entry.size != null &&
      Number(entry.size) > 0 &&
      Number(entry.size) !== st.size
    ) {
      delete index.entries[sha];
      saveShaIndex(root, index);
      return null;
    }
  } catch {
    return null;
  }

  const fileName = path.basename(absolute);
  const folder = path.dirname(relPath).replace(/\\/g, "/");
  return {
    path: relPath,
    fileName,
    folder: folder === "." ? "" : folder,
    size: Number(entry.size) || fs.statSync(absolute).size,
    sha256: sha,
  };
}

export function recordPhotoDumpSha(rootPath, sha256, relativePath, size) {
  const sha = String(sha256 || "")
    .trim()
    .toLowerCase();
  const rel = String(relativePath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .trim();
  if (!/^[a-f0-9]{64}$/.test(sha) || !rel) return;
  const root = assertAbsoluteRootPath(rootPath);
  const index = loadShaIndex(root);
  index.entries[sha] = {
    path: rel,
    size: Number(size) || 0,
    addedAt: new Date().toISOString(),
  };
  saveShaIndex(root, index);
}

/**
 * Build a duplicate-skip response (no new bytes written).
 */
export function photoDumpDuplicateResult(hit) {
  return {
    ok: true,
    verified: true,
    duplicate: true,
    folder: hit.folder || "",
    fileName: hit.fileName,
    size: hit.size,
    sha256: hit.sha256,
    path: hit.path,
  };
}

/**
 * Stream request body to disk under root/folder while hashing.
 * @param {import('node:stream').Readable} stream
 * @param {{
 *   relativeFolder?: string,
 *   originalName: string,
 *   expectedSize?: number,
 *   expectedSha256?: string,
 *   maxBytes?: number,
 *   apiKey?: string,
 * }} opts
 */
export async function savePhotoDumpUploadStream(stream, opts) {
  const settings = assertPhotoDumpEnabled();
  ensureRootExists(settings.rootPath);
  const { absolute: folderAbs, relative } = resolveWritableFolder(
    settings.rootPath,
    opts.relativeFolder || "",
  );

  const max = opts.maxBytes || settings.maxFileBytes || DEFAULT_MAX_BYTES;
  if (
    opts.expectedSize != null &&
    Number(opts.expectedSize) > 0 &&
    Number(opts.expectedSize) > max
  ) {
    throw new Error(`File exceeds max size (${max} bytes).`);
  }
  const quota = assertUploadQuota(
    opts.apiKey || settings.apiKey,
    opts.expectedSize || 0,
  );
  assertEnoughFreeSpace(folderAbs, Number(opts.expectedSize) || 0);

  const tmp = path.join(
    folderAbs,
    `.partial-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
  );
  const hash = crypto.createHash("sha256");
  let size = 0;
  let settled = false;
  const refund = () =>
    refundUploadQuota(
      opts.apiKey || settings.apiKey,
      quota.reservedBytes || size || 0,
    );

  const ws = fs.createWriteStream(tmp);
  const fail = (err) => {
    if (settled) return;
    settled = true;
    try {
      stream.destroy?.(err);
    } catch {
      // ignore
    }
    try {
      ws.destroy(err);
    } catch {
      // ignore
    }
  };

  try {
    await new Promise((resolve, reject) => {
      const doneOk = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const doneErr = (err) => {
        fail(err);
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      const onAbort = () => {
        doneErr(new Error("Upload aborted."));
      };

      let gotEnd = false;
      stream.on("data", (chunk) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buf.length;
        if (size > max) {
          doneErr(new Error(`File exceeds max size (${max} bytes).`));
          return;
        }
        hash.update(buf);
        if (!ws.write(buf)) {
          stream.pause();
          ws.once("drain", () => stream.resume());
        }
      });
      stream.on("end", () => {
        gotEnd = true;
        ws.end();
      });
      stream.on("error", doneErr);
      stream.on("aborted", onAbort);
      stream.on("close", () => {
        if (!settled && !gotEnd) onAbort();
      });
      ws.on("error", doneErr);
      ws.on("finish", doneOk);
    });

    // Ensure write stream fully flushed even if race settled via finish.
    try {
      await finished(ws).catch(() => {});
    } catch {
      // ignore
    }

    if (size === 0) {
      throw new Error("Empty upload.");
    }
    if (
      opts.expectedSize != null &&
      Number(opts.expectedSize) > 0 &&
      Number(opts.expectedSize) !== size
    ) {
      throw new Error(
        `Size mismatch: client ${opts.expectedSize}, received ${size}.`,
      );
    }

    const sha256 = hash.digest("hex");
    const expectedSha = String(opts.expectedSha256 || "")
      .trim()
      .toLowerCase();
    const clientProvidedSha = Boolean(expectedSha);
    if (clientProvidedSha && expectedSha !== sha256) {
      throw new Error("SHA-256 mismatch — file not saved. Phone copy kept.");
    }

    // Content already on disk from a prior upload — drop temp and skip write.
    const existing = findPhotoDumpBySha(settings.rootPath, sha256);
    if (existing) {
      refund();
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {
        // ignore
      }
      return photoDumpDuplicateResult(existing);
    }

    const written = fs.statSync(tmp).size;
    if (written !== size) {
      throw new Error(`Write size mismatch: ${written} vs ${size}.`);
    }

    // Streamed re-hash of temp file before rename (network mounts / torn writes).
    const diskHash = crypto.createHash("sha256");
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(tmp);
      rs.on("data", (chunk) => diskHash.update(chunk));
      rs.on("error", reject);
      rs.on("end", resolve);
    });
    const diskSha = diskHash.digest("hex");
    if (diskSha !== sha256) {
      throw new Error("On-disk SHA-256 mismatch — upload rejected.");
    }

    const { fileName } = finalizeUniqueDest(tmp, folderAbs, opts.originalName);
    const relPath = path.join(relative, fileName).replace(/\\/g, "/");
    if (clientProvidedSha || sha256) {
      recordPhotoDumpSha(settings.rootPath, sha256, relPath, size);
    }

    return {
      ok: true,
      verified: clientProvidedSha,
      duplicate: false,
      folder: relative.replace(/\\/g, "/"),
      fileName,
      size,
      sha256,
      path: relPath,
    };
  } catch (err) {
    refund();
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw err;
  }
}

function assertHttpPairUrl(raw) {
  const base = String(raw || "").trim().replace(/\/+$/, "");
  if (!base) throw new Error("Hub URL is required for the setup QR.");
  let parsed;
  try {
    parsed = new URL(base);
  } catch {
    throw new Error("Hub URL for Mobile QR must be a valid http(s) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Hub URL for Mobile QR must start with http:// or https://.");
  }
  if (!parsed.hostname) {
    throw new Error("Hub URL for Mobile QR is missing a host.");
  }
  return base;
}

/** Setup QR / paste payload for Mobile (Market Advisor companion style). */
export function encodePhotoDumpPairPayload({ url, key, token }) {
  const base = assertHttpPairUrl(url);
  const apiKey = String(key || "").trim();
  if (!apiKey) throw new Error("API key is required for the setup QR.");
  const params = new URLSearchParams();
  params.set("url", base);
  params.set("key", apiKey);
  const hubToken = String(token || "").trim();
  if (hubToken) params.set("token", hubToken);
  return `arrs-hub-photo-dump://v1?${params.toString()}`;
}

export function encodePhotoDumpPairJson({ url, key, token }) {
  const payload = {
    v: 1,
    url: assertHttpPairUrl(url),
    key: String(key || "").trim(),
  };
  const hubToken = String(token || "").trim();
  if (hubToken) payload.token = hubToken;
  return JSON.stringify(payload);
}

/** Hostname hints for Mobile QR (WAN preferred for away use; LAN also returned). */
export async function photoDumpPairHostHint(port, opts = {}) {
  const settings = loadPhotoDumpSettings();
  const lanIp = pickPrimaryLanIpv4();
  const publicIp = await detectPublicIpv4({ timeoutMs: 2000 });
  const p = Number(port) || 3000;
  const lanUrl = lanIp ? `http://${lanIp}:${p}` : "";
  const publicUrl = publicIp ? `http://${publicIp}:${p}` : "";
  const savedPair = String(opts.pairUrl ?? settings.pairUrl ?? "")
    .trim()
    .replace(/\/+$/, "");
  const preferPublic =
    opts.preferPublicPairUrl !== undefined
      ? Boolean(opts.preferPublicPairUrl)
      : settings.preferPublicPairUrl !== false;

  let preferredUrl = savedPair;
  if (!preferredUrl) {
    preferredUrl = preferPublic
      ? publicUrl || lanUrl
      : lanUrl || publicUrl;
  }

  return {
    lanIp: lanIp || "",
    publicIp: publicIp || "",
    port: p,
    lanUrl,
    publicUrl,
    preferredUrl,
    preferPublicPairUrl: preferPublic,
    savedPairUrl: savedPair,
    hostname: os.hostname(),
  };
}
