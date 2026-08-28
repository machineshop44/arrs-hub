const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const {
  syncOpenAtLogin,
  toggleOpenAtLogin,
} = require("./win-login-item.cjs");

const HUB_PORT = String(
  process.env.ARRS_HUB_PORT ||
    process.env.PORT ||
    process.env.ARRS_HUB_SYNC_PORT ||
    "3000",
);
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
let openAtLoginEnabled = true;
const HUB_LOGIN_SETTINGS_FILE = "hub-desktop-settings.json";

app.setAppUserModelId("com.machineshop44.arrs-hub");

function getHubVariant() {
  const fromEnv = String(process.env.ARRS_HUB_VARIANT || "").trim().toLowerCase();
  if (fromEnv === "lite" || fromEnv === "arrs-hub-lite") return "lite";
  try {
    const pkgPath = path.join(app.getAppPath(), "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      const meta = String(pkg.arrsHubVariant || "").trim().toLowerCase();
      if (meta === "lite") return "lite";
      if (String(pkg.name || "").includes("lite")) return "lite";
    }
  } catch {
    // ignore
  }
  return "full";
}

function isLiteHub() {
  return getHubVariant() === "lite";
}

function isPackaged() {
  return app.isPackaged;
}

/** Repo root (dev) or app.asar.unpacked / resources path (packaged). */
function getHubRoot() {
  if (isPackaged()) {
    const unpacked = path.join(process.resourcesPath, "app.asar.unpacked");
    if (fs.existsSync(path.join(unpacked, "server", "index.mjs"))) {
      return unpacked;
    }
    // asar:false installs land files next to app.asar / in app path
    return app.getAppPath();
  }
  return path.resolve(__dirname, "..");
}

function getDistDir(root) {
  return path.join(root, "dist");
}

function getDataDir() {
  if (isPackaged()) {
    return path.join(app.getPath("userData"), "data");
  }
  return path.join(getHubRoot(), "data");
}

function getIconPaths() {
  const root = getHubRoot();
  return {
    ico: path.join(__dirname, "icon.ico"),
    png: path.join(__dirname, "icon.png"),
    // Packaged builds may also ship icons under build/
    buildIco: path.join(root, "build", "icon.ico"),
    buildPng: path.join(root, "build", "icon.png"),
  };
}

function loadIcon() {
  const icons = getIconPaths();
  for (const candidate of [icons.ico, icons.buildIco, icons.png, icons.buildPng]) {
    if (candidate && fs.existsSync(candidate)) {
      return nativeImage.createFromPath(candidate);
    }
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

/**
 * Prefer Electron's bundled Node (packaged = zero system Node).
 * Dev/unpackaged can fall back to PATH node.exe.
 */
function resolveNodeBinary() {
  if (process.env.ARRS_HUB_NODE && fs.existsSync(process.env.ARRS_HUB_NODE)) {
    return { bin: process.env.ARRS_HUB_NODE, electronAsNode: false };
  }

  // Always usable: this process is Electron. ELECTRON_RUN_AS_NODE runs plain Node.
  if (process.execPath && fs.existsSync(process.execPath)) {
    return { bin: process.execPath, electronAsNode: true };
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
    if (first && fs.existsSync(first)) {
      return { bin: first, electronAsNode: false };
    }
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
      if (candidate && fs.existsSync(candidate)) {
        return { bin: candidate, electronAsNode: false };
      }
    }
  }

  return null;
}

function nodeSupportsSystemCa(nodePath, electronAsNode) {
  if (systemCaSupported !== null) return systemCaSupported;
  const env = electronAsNode
    ? { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
    : { ...process.env };
  const probe = spawnSync(nodePath, ["--use-system-ca", "-e", "process.exit(0)"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 8000,
    env,
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
  } else if (isPackaged()) {
    parts.push(
      "No server output was captured. Try reinstalling Arrs Hub from the GitHub Release installer, or check that the hub port (default 3000; override with ARRS_HUB_PORT / PORT) is free.",
    );
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

  const root = getHubRoot();
  const dist = getDistDir(root);
  const dataDir = getDataDir();
  const expressDir = path.join(root, "node_modules", "express");
  const serverScript = path.join(root, "server", "index.mjs");

  if (!fs.existsSync(dist) || !fs.existsSync(path.join(dist, "index.html"))) {
    throw new Error(
      isPackaged()
        ? "UI build missing from the installed app. Reinstall Arrs Hub from the GitHub Release."
        : "UI build missing (dist/). Double-click Start Arrs Hub.bat once so it can run npm install and npm run build.",
    );
  }

  if (!fs.existsSync(serverScript)) {
    throw new Error(
      isPackaged()
        ? `Hub server missing at ${serverScript}. Reinstall Arrs Hub.`
        : `Hub server missing at ${serverScript}.`,
    );
  }

  if (!isPackaged() && !fs.existsSync(expressDir)) {
    throw new Error(
      "Dependencies missing (node_modules). Double-click Start Arrs Hub.bat once so it can run npm install.",
    );
  }

  const node = resolveNodeBinary();
  if (!node) {
    throw new Error(
      "Could not start the hub server (no Node runtime). Reinstall Arrs Hub, or install Node.js LTS from https://nodejs.org for the developer workflow.",
    );
  }

  fs.mkdirSync(dataDir, { recursive: true });

  const allowSystemCa = nodeSupportsSystemCa(node.bin, node.electronAsNode);
  const args = [];
  if (allowSystemCa) {
    // Prefer argv over NODE_OPTIONS — unsupported flags in NODE_OPTIONS crash Node immediately.
    args.push("--use-system-ca");
  }
  args.push(serverScript);

  // Version for the Node server child: package.json may not sit next to
  // app.asar.unpacked/server (ELECTRON_RUN_AS_NODE cannot read inside asar).
  let hubVersion = app.getVersion();
  let hubName = "arrs-hub";
  const hubVariant = getHubVariant();
  try {
    const pkgPath = path.join(app.getAppPath(), "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (pkg.version) hubVersion = String(pkg.version);
      if (pkg.name) hubName = String(pkg.name);
    }
  } catch {
    // app.getVersion() is enough
  }

  if (isLiteHub()) {
    app.setAppUserModelId("com.machineshop44.arrs-hub-lite");
  }

  const env = {
    ...process.env,
    ARRS_HUB_DESKTOP: "1",
    ARRS_HUB_SYNC_PORT: HUB_PORT,
    // LAN / port-forward by default; override with ARRS_HUB_BIND=127.0.0.1
    ARRS_HUB_BIND: process.env.ARRS_HUB_BIND || process.env.ARRS_HUB_HOST || "0.0.0.0",
    ARRS_HUB_ROOT: root,
    ARRS_HUB_DIST: dist,
    ARRS_HUB_DATA_DIR: dataDir,
    ARRS_HUB_APP_PATH: app.getAppPath(),
    ARRS_HUB_VERSION: hubVersion,
    ARRS_HUB_NAME: hubName,
    ARRS_HUB_VARIANT: hubVariant,
  };

  if (node.electronAsNode) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }

  const cleanedOptions = sanitizeNodeOptions(process.env.NODE_OPTIONS, allowSystemCa);
  if (cleanedOptions) {
    env.NODE_OPTIONS = cleanedOptions;
  } else {
    delete env.NODE_OPTIONS;
  }

  if (allowSystemCa) {
    env.NODE_USE_SYSTEM_CA = "1";
  }

  appendServerLog(
    `Starting: "${node.bin}" ${args.join(" ")}\n` +
      `root=${root}\ndata=${dataDir}\npackaged=${isPackaged()}\n`,
  );

  serverProcess = spawn(node.bin, args, {
    cwd: root,
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

/**
 * Kill the hub Express child (and its tree). Soft kill() is not enough on
 * Windows when the child is Arrs Hub.exe via ELECTRON_RUN_AS_NODE — the
 * orphan holds file locks and NSIS shows "cannot be closed" until Retry.
 */
function stopServer() {
  const child = serverProcess;
  serverProcess = null;
  if (!child) return;

  const pid = child.pid;
  try {
    if (process.platform === "win32" && pid) {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        timeout: 15000,
        encoding: "utf8",
      });
      return;
    }
    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // ignore
      }
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
}

function getWindowTitle() {
  let version = app.getVersion();
  try {
    const pkgPath = path.join(app.getAppPath(), "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (pkg.version) version = String(pkg.version);
    }
  } catch {
    // app.getVersion() is enough
  }
  if (isLiteHub()) {
    return "Arrs Hub Lite v" + version + " — qBit & SAB port watch for downloaders";
  }
  return "Arrs Hub v" + version + " — Your Plex & *arr stack in one place";
}

/**
 * Locate VLC for Windows (same idea as mobile external player).
 * @returns {string|null}
 */
function findVlcPath() {
  const candidates = [
    path.join(process.env.ProgramFiles || "C:\\Program Files", "VideoLAN", "VLC", "vlc.exe"),
    path.join(
      process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
      "VideoLAN",
      "VLC",
      "vlc.exe",
    ),
    path.join(process.env.LOCALAPPDATA || "", "Programs", "VideoLAN", "VLC", "vlc.exe"),
  ];
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {
      // try next
    }
  }
  try {
    const which = spawnSync("where", ["vlc"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (which.status === 0) {
      const first = String(which.stdout || "")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find(Boolean);
      if (first && fs.existsSync(first)) return first;
    }
  } catch {
    // ignore
  }
  return null;
}

ipcMain.handle("workouts:play-vlc", async (_event, payload) => {
  const urls = Array.isArray(payload?.urls)
    ? payload.urls.map((u) => String(u || "").trim()).filter(Boolean)
    : [];
  if (urls.length === 0) {
    return { ok: false, error: "No media URLs to open in VLC." };
  }
  for (const url of urls) {
    if (!/^https?:\/\//i.test(url)) {
      return { ok: false, error: `VLC needs an absolute http(s) URL (got: ${url})` };
    }
  }
  const vlcPath = findVlcPath();
  if (!vlcPath) {
    return {
      ok: false,
      error:
        "VLC is not installed. Install VLC for Windows (videolan.org), then try again — same as Arrs Hub Mobile.",
    };
  }
  try {
    // Playlist: warm-up then day. --no-video-title-show keeps UI cleaner.
    const child = spawn(vlcPath, ["--started-from-file", ...urls], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
    return { ok: true, vlcPath };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      vlcPath,
    };
  }
});

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
    title: getWindowTitle(),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs"),
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

/**
 * Tray Quit: kill Express child tree, then exit hard so NSIS upgrades do not
 * hit leftover Arrs Hub.exe file locks ("cannot be closed… Retry").
 */
function forceQuitFromTray() {
  isQuitting = true;
  stopServer();
  if (tray) {
    try {
      tray.destroy();
    } catch {
      // ignore
    }
    tray = null;
  }
  // Prefer exit over quit so we do not linger waiting on window close handlers.
  try {
    app.exit(0);
  } catch {
    process.exit(0);
  }
}

function hubAppDisplayName() {
  return isLiteHub() ? "Arrs Hub Lite" : "Arrs Hub";
}

function toggleHubStartup() {
  openAtLoginEnabled = toggleOpenAtLogin(
    app,
    HUB_LOGIN_SETTINGS_FILE,
    hubAppDisplayName(),
  );
  refreshHubTrayMenu();
}

function refreshHubTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: isLiteHub() ? "Open Arrs Hub Lite" : "Open Arrs Hub",
        click: () => showWindow(),
      },
      {
        label: "Open in browser",
        click: () => shell.openExternal(HUB_URL),
      },
      { type: "separator" },
      {
        label: "Start with Windows",
        type: "checkbox",
        checked: openAtLoginEnabled,
        click: () => toggleHubStartup(),
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => forceQuitFromTray(),
      },
    ]),
  );
}

function createTray() {
  const icon = loadIcon();
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }));
  tray.setToolTip(hubAppDisplayName());
  refreshHubTrayMenu();
  tray.on("double-click", () => showWindow());
}

async function boot() {
  openAtLoginEnabled = syncOpenAtLogin(
    app,
    HUB_LOGIN_SETTINGS_FILE,
    hubAppDisplayName(),
    true,
  );
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

  app.on("will-quit", () => {
    isQuitting = true;
    stopServer();
    if (tray) {
      try {
        tray.destroy();
      } catch {
        // ignore
      }
      tray = null;
    }
  });

  app.on("window-all-closed", () => {
    // Stay alive in the tray; Quit from the tray menu sets isQuitting.
    if (isQuitting) {
      stopServer();
    }
  });
}
