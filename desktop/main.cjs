const { app, BrowserWindow, Tray, Menu, nativeImage, shell } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const EXPRESS_DIR = path.join(ROOT, "node_modules", "express");
const ICON_ICO = path.join(__dirname, "icon.ico");
const ICON_PNG = path.join(__dirname, "icon.png");
const HUB_PORT = "3000";
const HUB_URL = `http://127.0.0.1:${HUB_PORT}`;
const HEALTH_URL = `http://127.0.0.1:${HUB_PORT}/api/health`;
const HEALTH_TIMEOUT_MS = 90000;
const LOG_CAP = 8000;

let mainWindow = null;
let tray = null;
let serverProcess = null;
let isQuitting = false;
let serverLog = "";
let serverExit = null;
let systemCaSupported = null;

app.setAppUserModelId("com.machineshop44.arrs-hub");

function loadIcon() {
  if (fs.existsSync(ICON_ICO)) {
    return nativeImage.createFromPath(ICON_ICO);
  }
  if (fs.existsSync(ICON_PNG)) {
    return nativeImage.createFromPath(ICON_PNG);
  }
  return nativeImage.createEmpty();
}

function appendServerLog(chunk) {
  serverLog += String(chunk);
  if (serverLog.length > LOG_CAP) {
    serverLog = serverLog.slice(-LOG_CAP);
  }
}

function trimLog(text) {
  const cleaned = String(text || "")
    .replace(/\r/g, "")
    .trim();
  if (!cleaned) return "";
  return cleaned.length > 1500 ? cleaned.slice(-1500) : cleaned;
}

function resolveNodeBinary() {
  if (process.env.ARRS_HUB_NODE && fs.existsSync(process.env.ARRS_HUB_NODE)) {
    return process.env.ARRS_HUB_NODE;
  }

  const whichCmd = process.platform === "win32" ? "where" : "which";
  const found = spawnSync(whichCmd, ["node"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (found.status === 0) {
    const first = String(found.stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (first && fs.existsSync(first)) return first;
  }

  if (process.platform === "win32") {
    const candidates = [
      path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe"),
      path.join(
        process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
        "nodejs",
        "node.exe",
      ),
      path.join(process.env.LOCALAPPDATA || "", "Programs", "nodejs", "node.exe"),
    ];
    for (const candidate of candidates) {
      if (candidate && fs.existsSync(candidate)) return candidate;
    }
  }

  return null;
}

function nodeSupportsSystemCa(nodePath) {
  if (systemCaSupported !== null) return systemCaSupported;
  const probe = spawnSync(nodePath, ["--use-system-ca", "-e", "process.exit(0)"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 8000,
  });
  systemCaSupported = probe.status === 0;
  return systemCaSupported;
}

/** Remove flags that crash older Node when inherited via NODE_OPTIONS. */
function sanitizeNodeOptions(raw, allowSystemCa) {
  const parts = String(raw || "")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => {
      if (part === "--use-system-ca") return allowSystemCa;
      return true;
    });
  return parts.join(" ");
}

function failureDetails(prefix) {
  const parts = [prefix];
  if (serverExit?.error) {
    parts.push(`Spawn error: ${serverExit.error.message || serverExit.error}`);
  } else if (serverExit && (serverExit.code != null || serverExit.signal)) {
    parts.push(
      `Server exited (code ${serverExit.code ?? "null"}${
        serverExit.signal ? `, signal ${serverExit.signal}` : ""
      }).`,
    );
  }
  const log = trimLog(serverLog);
  if (log) {
    parts.push(`Server output:\n${log}`);
  } else {
    parts.push(
      "No server output was captured. Run Start Arrs Hub.bat from this folder (not a broken shortcut) so npm install / build can finish.",
    );
  }
  return parts.join("\n\n");
}

function waitForHealth(timeoutMs = HEALTH_TIMEOUT_MS) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const fail = (message) => {
      reject(new Error(failureDetails(message)));
    };

    const tryOnce = () => {
      if (serverExit) {
        fail("Hub server stopped before it became ready.");
        return;
      }

      const req = http.get(HEALTH_URL, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          resolve();
          return;
        }
        retry();
      });
      req.on("error", retry);
      req.setTimeout(1500, () => {
        req.destroy();
        retry();
      });
    };

    const retry = () => {
      if (serverExit) {
        fail("Hub server stopped before it became ready.");
        return;
      }
      if (Date.now() - started > timeoutMs) {
        fail(
          `Hub server did not become ready in time (${Math.round(timeoutMs / 1000)}s) at ${HEALTH_URL}.`,
        );
        return;
      }
      setTimeout(tryOnce, 250);
    };

    tryOnce();
  });
}

function startServer() {
  serverLog = "";
  serverExit = null;

  if (!fs.existsSync(DIST) || !fs.existsSync(path.join(DIST, "index.html"))) {
    throw new Error(
      "UI build missing (dist/). Double-click Start Arrs Hub.bat once so it can run npm install and npm run build.",
    );
  }

  if (!fs.existsSync(EXPRESS_DIR)) {
    throw new Error(
      "Dependencies missing (node_modules). Double-click Start Arrs Hub.bat once so it can run npm install.",
    );
  }

  const nodePath = resolveNodeBinary();
  if (!nodePath) {
    throw new Error(
      "Node.js was not found on PATH. Install Node.js LTS from https://nodejs.org, reopen the terminal, then run Start Arrs Hub.bat again.",
    );
  }

  const allowSystemCa = nodeSupportsSystemCa(nodePath);
  const args = [];
  if (allowSystemCa) {
    // Prefer argv over NODE_OPTIONS — unsupported flags in NODE_OPTIONS crash Node immediately.
    args.push("--use-system-ca");
  }
  args.push(path.join(ROOT, "server", "index.mjs"));

  const env = {
    ...process.env,
    ARRS_HUB_DESKTOP: "1",
    ARRS_HUB_SYNC_PORT: HUB_PORT,
  };

  const cleanedOptions = sanitizeNodeOptions(process.env.NODE_OPTIONS, allowSystemCa);
  if (cleanedOptions) {
    env.NODE_OPTIONS = cleanedOptions;
  } else {
    delete env.NODE_OPTIONS;
  }

  // Harmless on older Node; used by newer builds instead of / alongside the flag.
  if (allowSystemCa) {
    env.NODE_USE_SYSTEM_CA = "1";
  }

  appendServerLog(`Starting: "${nodePath}" ${args.join(" ")}\n`);

  serverProcess = spawn(nodePath, args, {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  serverProcess.stdout?.on("data", appendServerLog);
  serverProcess.stderr?.on("data", appendServerLog);

  serverProcess.on("error", (err) => {
    serverExit = { error: err };
    appendServerLog(`spawn error: ${err.message || err}\n`);
  });

  serverProcess.on("exit", (code, signal) => {
    serverExit = { code, signal };
    serverProcess = null;
    if (!isQuitting && code && code !== 0) {
      console.error("Hub server exited unexpectedly:", code, trimLog(serverLog));
    }
  });
}

function stopServer() {
  if (!serverProcess) return;
  try {
    serverProcess.kill();
  } catch {
    // ignore
  }
  serverProcess = null;
}

function createWindow() {
  const icon = loadIcon();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    icon,
    title: "Arrs Hub",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(HUB_URL);

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

function showWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  const icon = loadIcon();
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }));
  tray.setToolTip("Arrs Hub");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Arrs Hub", click: () => showWindow() },
      {
        label: "Open in browser",
        click: () => shell.openExternal(HUB_URL),
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("double-click", () => showWindow());
}

async function boot() {
  startServer();
  await waitForHealth();
  createTray();
  createWindow();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());

  app.whenReady().then(() => {
    boot().catch((err) => {
      console.error(err);
      const { dialog } = require("electron");
      dialog.showErrorBox("Arrs Hub failed to start", String(err?.message || err));
      isQuitting = true;
      app.quit();
    });
  });

  app.on("before-quit", () => {
    isQuitting = true;
    stopServer();
  });

  app.on("window-all-closed", () => {
    // Stay alive in the tray; Quit from the tray menu sets isQuitting.
  });
}
