import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import AdmZip from "adm-zip";
import {
  CONFIG_PATH,
  EXE_PATH,
  RECYCLARR_DIR,
  ensureDataDirs,
} from "./config.mjs";
import {
  buildPendingChangesSummary,
  filterRecyclarrLogForUi,
} from "./preview-summary.mjs";

const RELEASES_URL =
  "https://api.github.com/repos/recyclarr/recyclarr/releases/latest";

export function isRecyclarrInstalled() {
  return fs.existsSync(EXE_PATH);
}

export async function getInstalledVersion() {
  if (!isRecyclarrInstalled()) return null;
  try {
    const { stdout } = await runRecyclarr(["--version"], { timeoutMs: 15000 });
    return stdout.trim().split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

export async function ensureRecyclarrInstalled() {
  ensureDataDirs();
  if (isRecyclarrInstalled()) {
    return { installed: true, downloaded: false };
  }
  await downloadRecyclarr();
  return { installed: true, downloaded: true };
}

async function downloadRecyclarr() {
  const releaseRes = await fetch(RELEASES_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "arrs-hub",
    },
  });
  if (!releaseRes.ok) {
    throw new Error(`Failed to fetch Recyclarr releases (${releaseRes.status})`);
  }
  const release = await releaseRes.json();
  const asset = (release.assets ?? []).find(
    (item) => item.name === "recyclarr-win-x64.zip",
  );
  if (!asset?.browser_download_url) {
    throw new Error("Could not find recyclarr-win-x64.zip in the latest release");
  }

  const zipPath = path.join(RECYCLARR_DIR, "recyclarr-win-x64.zip");
  const zipRes = await fetch(asset.browser_download_url, {
    headers: { "User-Agent": "arrs-hub" },
    redirect: "follow",
  });
  if (!zipRes.ok || !zipRes.body) {
    throw new Error(`Failed to download Recyclarr (${zipRes.status})`);
  }

  await pipeline(Readable.fromWeb(zipRes.body), createWriteStream(zipPath));

  const zip = new AdmZip(zipPath);
  zip.extractAllTo(RECYCLARR_DIR, true);
  fs.unlinkSync(zipPath);

  if (!fs.existsSync(EXE_PATH)) {
    // Some zips nest the exe one folder deep
    const nested = findFile(RECYCLARR_DIR, "recyclarr.exe");
    if (nested && nested !== EXE_PATH) {
      fs.copyFileSync(nested, EXE_PATH);
    }
  }

  if (!fs.existsSync(EXE_PATH)) {
    throw new Error("Recyclarr downloaded but recyclarr.exe was not found");
  }
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) {
      return full;
    }
    if (entry.isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    }
  }
  return null;
}

/**
 * @param {string[]} args
 * @param {{ timeoutMs?: number, onOutput?: (chunk: string, stream: 'stdout'|'stderr') => void, onStatus?: (message: string) => void, needsConsole?: boolean }} [options]
 */
export function runRecyclarr(args, options = {}) {
  if (options.needsConsole && process.platform === "win32") {
    return runRecyclarrWindowsConsole(args, options);
  }
  return runRecyclarrPiped(args, options);
}

function recyclarrEnv() {
  const env = { ...process.env };
  delete env.RECYCLARR_APP_DATA;
  return {
    ...env,
    RECYCLARR_CONFIG_DIR: path.join(RECYCLARR_DIR, "config"),
    RECYCLARR_DATA_DIR: path.join(RECYCLARR_DIR, "data"),
  };
}

/**
 * Normal piped spawn — fine for --version and --preview.
 * @param {string[]} args
 * @param {{ timeoutMs?: number, onOutput?: (chunk: string, stream: 'stdout'|'stderr') => void }} [options]
 */
function runRecyclarrPiped(args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 300000;
  const onOutput = options.onOutput;

  return new Promise((resolve, reject) => {
    if (!fs.existsSync(EXE_PATH)) {
      reject(new Error("Recyclarr is not installed yet"));
      return;
    }

    const child = spawn(EXE_PATH, args, {
      cwd: RECYCLARR_DIR,
      windowsHide: true,
      env: recyclarrEnv(),
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Recyclarr timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      onOutput?.(text, "stdout");
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      onOutput?.(text, "stderr");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ code, stdout, stderr });
      } else {
        const err = new Error(
          stderr.trim() || stdout.trim() || `Recyclarr exited with code ${code}`,
        );
        err.stdout = stdout;
        err.stderr = stderr;
        err.code = code;
        reject(err);
      }
    });
  });
}

/**
 * Real Apply sync uses Spectre LiveDisplay, which crashes with
 * "The handle is invalid" when stdout is piped. On Windows we open a
 * minimized console via `start /wait` and stream Recyclarr's log file instead.
 * @param {string[]} args
 * @param {{ timeoutMs?: number, onOutput?: (chunk: string, stream: 'stdout'|'stderr') => void, onStatus?: (message: string) => void }} [options]
 */
function runRecyclarrWindowsConsole(args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 300000;
  const onOutput = options.onOutput;
  const onStatus = options.onStatus;

  return new Promise((resolve, reject) => {
    if (!fs.existsSync(EXE_PATH)) {
      reject(new Error("Recyclarr is not installed yet"));
      return;
    }

    const exitFile = path.join(RECYCLARR_DIR, ".last-sync-exit");
    const logDir = path.join(RECYCLARR_DIR, "data", "logs", "cli");
    try {
      fs.unlinkSync(exitFile);
    } catch {
      // ignore
    }

    const startedAt = Date.now();
    const argLine = args.map(quoteCmdArg).join(" ");
    const cmdline = `start "Arrs Hub Sync" /wait /min ${quoteCmdArg(EXE_PATH)} ${argLine} & echo %ERRORLEVEL%>${quoteCmdArg(exitFile)}`;

    onStatus?.("Applying sync — watch this popup (a brief console may flash)…");
    onOutput?.(
      "[hub] Apply started. Keep this popup open until you see SUCCESS or FAILED.\n",
      "stdout",
    );

    const child = spawn("cmd.exe", ["/d", "/s", "/c", cmdline], {
      cwd: RECYCLARR_DIR,
      windowsHide: true,
      env: recyclarrEnv(),
    });

    let stdout = "";
    let stopped = false;
    let offset = 0;
    /** @type {string|null} */
    let activeLog = null;
    let lastStatusAt = Date.now();

    const pushText = (text) => {
      if (!text) return;
      stdout += text;
      onOutput?.(text, "stdout");

      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        if (/Processing (Radarr|Sonarr)/i.test(line)) {
          onStatus?.(line.replace(/^\[INF\]\s*/i, "").trim());
        } else if (/Completed at /i.test(line)) {
          onStatus?.(line.replace(/^\[INF\]\s*/i, "").trim());
        } else if (/Created |Updated |Synced /i.test(line)) {
          onStatus?.(line.replace(/^\[INF\]\s*/i, "").trim());
        }
      }
    };

    const pollLogs = () => {
      if (stopped) return;
      try {
        if (!fs.existsSync(logDir)) return;
        const newest = fs
          .readdirSync(logDir)
          .filter((name) => name.endsWith(".debug.log"))
          .map((name) => {
            const full = path.join(logDir, name);
            return { full, mtime: fs.statSync(full).mtimeMs };
          })
          .filter((item) => item.mtime >= startedAt - 2000)
          .sort((a, b) => b.mtime - a.mtime)[0];

        if (!newest) return;
        if (activeLog !== newest.full) {
          activeLog = newest.full;
          offset = 0;
        }

        const stat = fs.statSync(activeLog);
        if (stat.size <= offset) return;
        const fd = fs.openSync(activeLog, "r");
        try {
          const length = stat.size - offset;
          const buffer = Buffer.alloc(length);
          fs.readSync(fd, buffer, 0, length, offset);
          offset = stat.size;
          const chunk = buffer.toString("utf8");
          const cleaned = chunk
            .split(/\r?\n/)
            .map((line) =>
              line.replace(
                /^\[\d{2}:\d{2}:\d{2} (DBG|INF|WRN|ERR|FTL)\]\s*/i,
                "[$1] ",
              ),
            )
            .join("\n");
          pushText(cleaned);
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        // ignore transient read errors while log rotates
      }

      if (Date.now() - lastStatusAt > 8000) {
        lastStatusAt = Date.now();
        const secs = Math.round((Date.now() - startedAt) / 1000);
        onStatus?.(`Still applying… ${secs}s elapsed`);
      }
    };

    const logTimer = setInterval(pollLogs, 400);
    const timer = setTimeout(() => {
      stopped = true;
      clearInterval(logTimer);
      child.kill();
      reject(new Error(`Recyclarr timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    child.on("error", (err) => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(logTimer);
      reject(err);
    });

    child.on("close", () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(logTimer);
      pollLogs();

      let code = 1;
      try {
        const raw = fs.readFileSync(exitFile, "utf8").trim();
        code = Number.parseInt(raw, 10);
        if (!Number.isFinite(code)) code = 1;
      } catch {
        code = 1;
      }

      if (code === 0) {
        resolve({ code, stdout, stderr: "" });
        return;
      }

      const err = new Error(
        filterRecyclarrLogForUi(stdout).trim() ||
          `Recyclarr exited with code ${code}`,
      );
      err.stdout = stdout;
      err.stderr = "";
      err.code = code;
      reject(err);
    });
  });
}

/** @param {string} value */
function quoteCmdArg(value) {
  const text = String(value);
  if (!/[ \t"]/g.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

/**
 * @param {string} yaml
 * @param {{
 *   preview?: boolean,
 *   settings?: object,
 *   onStatus?: (message: string) => void,
 *   onOutput?: (chunk: string) => void,
 * }} [options]
 */
export async function runSync(yaml, options = {}) {
  const preview = Boolean(options.preview);
  const onStatus = options.onStatus;
  const onOutput = options.onOutput;
  const settings = options.settings ?? {};

  ensureDataDirs();
  onStatus?.("Checking Recyclarr install…");
  await ensureRecyclarrInstalled();
  onStatus?.("Writing sync config…");
  fs.writeFileSync(CONFIG_PATH, yaml, "utf8");

  // Preview uses debug so we can build a pending-changes summary.
  // Apply needs a real Windows console — Recyclarr LiveDisplay crashes when piped.
  const args = [
    "sync",
    "--config",
    CONFIG_PATH,
    "--log",
    preview ? "debug" : "info",
  ];
  if (preview) args.push("--preview");

  onStatus?.(
    preview
      ? "Running Recyclarr preview (no changes will be written)…"
      : "Running Recyclarr sync against Sonarr/Radarr…",
  );

  let rawLog = "";
  const result = await runRecyclarr(args, {
    needsConsole: !preview,
    onStatus: (message) => onStatus?.(message),
    onOutput: (chunk) => {
      rawLog += chunk;
      const filtered = filterRecyclarrLogForUi(chunk);
      if (filtered.trim()) onOutput?.(filtered);
    },
  });

  let summary = "";
  if (preview) {
    onStatus?.("Comparing guide vs your Sonarr/Radarr…");
    try {
      summary = await buildPendingChangesSummary(rawLog, settings);
      onOutput?.(`\n${summary}\n`);
    } catch (err) {
      summary = `Could not build pending-changes summary: ${
        err instanceof Error ? err.message : String(err)
      }`;
      onOutput?.(`\n${summary}\n`);
    }
  } else {
    onStatus?.("Sync finished successfully.");
    summary = buildApplyCompletionSummary(rawLog || result.stdout);
    onOutput?.(`\n${summary}\n`);
  }

  const uiStdout = [filterRecyclarrLogForUi(result.stdout), summary]
    .filter(Boolean)
    .join("\n\n");

  return {
    ...result,
    stdout: uiStdout,
    stderr: filterRecyclarrLogForUi(result.stderr),
    summary,
  };
}

/** @param {string} logText */
function buildApplyCompletionSummary(logText) {
  const lines = String(logText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const highlights = lines.filter((line) =>
    /\[INF\].*(Created|Updated|Synced|Deleted|Processing|Completed)/i.test(
      line,
    ),
  );

  return [
    "=== SYNC COMPLETED SUCCESSFULLY ===",
    "Changes were written to Sonarr/Radarr.",
    highlights.length
      ? highlights.slice(-20).join("\n")
      : "Recyclarr finished with exit code 0.",
    "",
    "You can Close this popup now.",
  ].join("\n");
}

export { CONFIG_PATH, EXE_PATH };
