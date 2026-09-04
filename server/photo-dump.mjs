/**
 * Remote photo/video dump: authenticated upload into a root folder on the Hub PC.
 * Mobile browses/creates subfolders under rootPath only (e.g. N:\PhoneDump).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, ensureDataDirs } from "./config.mjs";

export const PHOTO_DUMP_SETTINGS_PATH = path.join(
  DATA_DIR,
  "photo-dump-settings.json",
);

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

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

export function defaultPhotoDumpSettings() {
  return {
    enabled: true,
    /** Absolute Windows path — uploads stay under this tree only. */
    rootPath: "N:\\PhoneDump",
    apiKey: "",
    maxFileBytes: DEFAULT_MAX_BYTES,
  };
}

export function loadPhotoDumpSettings() {
  ensureDataDirs();
  if (!fs.existsSync(PHOTO_DUMP_SETTINGS_PATH)) {
    const defaults = defaultPhotoDumpSettings();
    savePhotoDumpSettings(defaults);
    return defaults;
  }
  const raw = JSON.parse(fs.readFileSync(PHOTO_DUMP_SETTINGS_PATH, "utf8"));
  const defaults = defaultPhotoDumpSettings();
  return {
    ...defaults,
    ...raw,
    rootPath: String(raw.rootPath || defaults.rootPath).trim() || defaults.rootPath,
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey : "",
    maxFileBytes: Math.max(
      1_000_000,
      Number(raw.maxFileBytes) || defaults.maxFileBytes,
    ),
    enabled: raw.enabled !== false,
  };
}

export function savePhotoDumpSettings(settings) {
  ensureDataDirs();
  fs.writeFileSync(
    PHOTO_DUMP_SETTINGS_PATH,
    `${JSON.stringify(settings, null, 2)}\n`,
    "utf8",
  );
  return settings;
}

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
  const next = {
    enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : current.enabled,
    rootPath:
      patch.rootPath !== undefined
        ? String(patch.rootPath || "").trim() || current.rootPath
        : current.rootPath,
    apiKey,
    maxFileBytes:
      patch.maxFileBytes !== undefined
        ? Math.max(1_000_000, Number(patch.maxFileBytes) || current.maxFileBytes)
        : current.maxFileBytes,
  };
  return savePhotoDumpSettings(next);
}

export function verifyPhotoDumpApiKey(provided) {
  const settings = loadPhotoDumpSettings();
  const expected = String(settings.apiKey || "").trim();
  if (!expected) return false;
  const got = String(provided || "").trim();
  if (!got || got.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  } catch {
    return false;
  }
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
    if (part === "." || part === "..") {
      throw new Error("Invalid folder path.");
    }
    if (/[<>:"|?*\u0000-\u001f]/.test(part)) {
      throw new Error(`Invalid folder name: ${part}`);
    }
  }
  return parts.join(path.sep);
}

export function resolveUnderRoot(rootPath, relativeFolder = "") {
  const root = path.resolve(String(rootPath || "").trim());
  if (!root) throw new Error("Photo dump root path is not set.");
  const rel = normalizeRelativeFolder(relativeFolder);
  const target = rel ? path.resolve(root, rel) : root;
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (target !== root && !target.startsWith(rootWithSep)) {
    throw new Error("Path escapes photo dump root.");
  }
  return { root, relative: rel, absolute: target };
}

function safeFileName(name) {
  const base = path.basename(String(name || "upload.bin")).trim() || "upload.bin";
  const cleaned = base.replace(/[<>:"|?*\u0000-\u001f]/g, "_").slice(0, 180);
  return cleaned || "upload.bin";
}

export function ensureRootExists(rootPath) {
  const root = path.resolve(String(rootPath || "").trim());
  if (!root) throw new Error("Photo dump root path is not set.");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/**
 * List immediate child folders under root/relativeFolder.
 */
export function listPhotoDumpFolders(relativeFolder = "") {
  const settings = loadPhotoDumpSettings();
  const { absolute } = resolveUnderRoot(settings.rootPath, relativeFolder);
  ensureRootExists(settings.rootPath);
  if (!fs.existsSync(absolute)) {
    fs.mkdirSync(absolute, { recursive: true });
  }
  const entries = fs.readdirSync(absolute, { withFileTypes: true });
  const folders = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const rel = normalizeRelativeFolder(relativeFolder);
  return {
    rootPath: settings.rootPath,
    path: rel.replace(/\\/g, "/"),
    folders,
  };
}

/**
 * Create a folder under root (relative path, may include nested segments).
 */
export function createPhotoDumpFolder(relativeFolder) {
  const settings = loadPhotoDumpSettings();
  const rel = normalizeRelativeFolder(relativeFolder);
  if (!rel) throw new Error("Folder name is required.");
  const { absolute } = resolveUnderRoot(settings.rootPath, rel);
  ensureRootExists(settings.rootPath);
  fs.mkdirSync(absolute, { recursive: true });
  return {
    path: rel.replace(/\\/g, "/"),
    absolute,
  };
}

/**
 * Write an uploaded file under root/folder. Verifies size and optional sha256.
 * @param {{
 *   relativeFolder?: string,
 *   originalName: string,
 *   buffer: Buffer,
 *   expectedSize?: number,
 *   expectedSha256?: string,
 * }} opts
 */
export function savePhotoDumpUpload(opts) {
  const settings = loadPhotoDumpSettings();
  if (settings.enabled === false) {
    throw new Error("Photo dump is disabled on the Hub.");
  }
  ensureRootExists(settings.rootPath);
  const { absolute: folderAbs, relative } = resolveUnderRoot(
    settings.rootPath,
    opts.relativeFolder || "",
  );
  fs.mkdirSync(folderAbs, { recursive: true });

  const buffer = opts.buffer;
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("Empty upload.");
  }
  const max = settings.maxFileBytes || DEFAULT_MAX_BYTES;
  if (buffer.length > max) {
    throw new Error(`File exceeds max size (${max} bytes).`);
  }
  if (
    opts.expectedSize != null &&
    Number(opts.expectedSize) > 0 &&
    Number(opts.expectedSize) !== buffer.length
  ) {
    throw new Error(
      `Size mismatch: client ${opts.expectedSize}, received ${buffer.length}.`,
    );
  }

  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  const expectedSha = String(opts.expectedSha256 || "")
    .trim()
    .toLowerCase();
  if (expectedSha && expectedSha !== sha256) {
    throw new Error("SHA-256 mismatch — file not saved. Phone copy kept.");
  }

  let fileName = safeFileName(opts.originalName);
  let dest = path.join(folderAbs, fileName);
  if (fs.existsSync(dest)) {
    const ext = path.extname(fileName);
    const stem = path.basename(fileName, ext);
    fileName = `${stem}-${Date.now()}${ext}`;
    dest = path.join(folderAbs, fileName);
  }

  const tmp = `${dest}.partial-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, buffer);
    const written = fs.statSync(tmp).size;
    if (written !== buffer.length) {
      throw new Error(`Write size mismatch: ${written} vs ${buffer.length}.`);
    }
    const diskSha = crypto
      .createHash("sha256")
      .update(fs.readFileSync(tmp))
      .digest("hex");
    if (diskSha !== sha256) {
      throw new Error("On-disk SHA-256 mismatch — upload rejected.");
    }
    fs.renameSync(tmp, dest);
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw err;
  }

  return {
    ok: true,
    verified: true,
    folder: relative.replace(/\\/g, "/"),
    fileName,
    size: buffer.length,
    sha256,
    path: path.join(relative, fileName).replace(/\\/g, "/"),
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
 * }} opts
 */
export async function savePhotoDumpUploadStream(stream, opts) {
  const settings = loadPhotoDumpSettings();
  if (settings.enabled === false) {
    throw new Error("Photo dump is disabled on the Hub.");
  }
  ensureRootExists(settings.rootPath);
  const { absolute: folderAbs, relative } = resolveUnderRoot(
    settings.rootPath,
    opts.relativeFolder || "",
  );
  fs.mkdirSync(folderAbs, { recursive: true });

  let fileName = safeFileName(opts.originalName);
  let dest = path.join(folderAbs, fileName);
  if (fs.existsSync(dest)) {
    const ext = path.extname(fileName);
    const stem = path.basename(fileName, ext);
    fileName = `${stem}-${Date.now()}${ext}`;
    dest = path.join(folderAbs, fileName);
  }

  const max = opts.maxBytes || settings.maxFileBytes || DEFAULT_MAX_BYTES;
  const tmp = `${dest}.partial-${process.pid}-${Date.now()}`;
  const hash = crypto.createHash("sha256");
  let size = 0;

  try {
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(tmp);
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        try {
          stream.destroy?.();
        } catch {
          // ignore
        }
        try {
          ws.destroy();
        } catch {
          // ignore
        }
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      stream.on("data", (chunk) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buf.length;
        if (size > max) {
          fail(new Error(`File exceeds max size (${max} bytes).`));
          return;
        }
        hash.update(buf);
        if (!ws.write(buf)) {
          stream.pause();
          ws.once("drain", () => stream.resume());
        }
      });
      stream.on("end", () => {
        ws.end();
      });
      stream.on("error", fail);
      ws.on("error", fail);
      ws.on("finish", done);
    });

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
    if (expectedSha && expectedSha !== sha256) {
      throw new Error("SHA-256 mismatch — file not saved. Phone copy kept.");
    }

    const written = fs.statSync(tmp).size;
    if (written !== size) {
      throw new Error(`Write size mismatch: ${written} vs ${size}.`);
    }
    fs.renameSync(tmp, dest);

    return {
      ok: true,
      verified: true,
      folder: relative.replace(/\\/g, "/"),
      fileName,
      size,
      sha256,
      path: path.join(relative, fileName).replace(/\\/g, "/"),
    };
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw err;
  }
}
