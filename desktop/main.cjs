const { app, BrowserWindow, Tray, Menu, nativeImage, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const ICON_ICO = path.join(__dirname, "icon.ico");
const ICON_PNG = path.join(__dirname, "icon.png");
const HUB_URL = "http://127.0.0.1:3000";
const HEALTH_URL = "http://127.0.0.1:3000/api/health";

let mainWindow = null;
let tray = null;
let serverProcess = null;
let isQuitting = false;

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

function waitForHealth(timeoutMs = 30000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
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
      if (Date.now() - started > timeoutMs) {
        reject(new Error("Hub server did not become ready in time."));
        return;
      }
      setTimeout(tryOnce, 250);
    };
    tryOnce();
  });
}

function startServer() {
  if (!fs.existsSync(DIST)) {
    throw new Error(
      "UI build missing (dist/). Run Start Arrs Hub.bat once so it can build.",
    );
  }

  const env = {
    ...process.env,
    ARRS_HUB_DESKTOP: "1",
    ARRS_HUB_SYNC_PORT: "3000",
  };

  serverProcess = spawn("node", [path.join(ROOT, "server", "index.mjs")], {
    cwd: ROOT,
    env,
    stdio: "ignore",
    windowsHide: true,
  });

  serverProcess.on("exit", (code) => {
    serverProcess = null;
    if (!isQuitting && code && code !== 0) {
      console.error("Hub server exited unexpectedly:", code);
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
