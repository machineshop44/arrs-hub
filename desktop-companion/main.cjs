const { app, Tray, Menu, nativeImage, shell, BrowserWindow, ipcMain, dialog } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const {
  syncOpenAtLogin,
  toggleOpenAtLogin,
} = require("./win-login-item.cjs");

const DEFAULT_PORT = "3901";
const HEALTH_TIMEOUT_MS = 60000;
const LOG_CAP = 12_000;

let tray = null;
let serverProcess = null;
let isQuitting = false;
let serverExit = null;
let serverLog = "";
let companionPort = DEFAULT_PORT;
let openAtLoginEnabled = true;

const LOGIN_SETTINGS_FILE = "companion-desktop-settings.json";
const APP_DISPLAY_NAME = "Arrs Hub Companion";
const BOOT_LOG_FILE = "companion-boot.log";

app.setAppUserModelId("com.machineshop44.arrs-hub-companion");

function isPackaged() {
  return app.isPackaged;
}

function getCompanionRoot() {
  if (isPackaged()) {
    const unpacked = path.join(process.resourcesPath, "app.asar.unpacked");
    if (fs.existsSync(path.join(unpacked, "companion", "server.mjs"))) {
      return unpacked;
    }
    return app.getAppPath();
  }
  return path.resolve(__dirname, "..");
}

function getDataDir() {
  if (isPackaged()) {
    return path.join(app.getPath("userData"), "data");
  }
  return path.join(getCompanionRoot(), "data");
}

function getIconPaths() {
  const root = getCompanionRoot();
  return [
    path.join(__dirname, "icon.ico"),
    path.join(__dirname, "icon.png"),
    path.join(root, "build", "icon.ico"),
    path.join(root, "build", "icon.png"),
    path.join(root, "desktop", "icon.ico"),
    path.join(root, "desktop", "icon.png"),
  ];
}

function loadIcon() {
  for (const candidate of getIconPaths()) {
    if (candidate && fs.existsSync(candidate)) {
      const image = nativeImage.createFromPath(candidate);
      if (!image.isEmpty()) return image;
    }
  }
  return nativeImage.createEmpty();
}

function trayIcon() {
  const icon = loadIcon();
  if (icon.isEmpty()) return icon;
  return icon.resize({ width: 16, height: 16 });
}

function readConfiguredPort(dataDir) {
  try {
    const settingsPath = path.join(dataDir, "companion-settings.json");
    if (!fs.existsSync(settingsPath)) return DEFAULT_PORT;
    const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const port = Number(raw.port);
    if (Number.isFinite(port) && port > 0 && port <= 65535) {
      return String(Math.floor(port));
    }
  } catch {
    // default
  }
  return DEFAULT_PORT;
}

function resolveNodeBinary() {
  if (process.execPath && fs.existsSync(process.execPath)) {
    return { bin: process.execPath, electronAsNode: true };
  }
  return null;
}

function stopServer() {
  const child = serverProcess;
  serverProcess = null;
  if (!child?.pid) return;
  try {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      timeout: 15000,
      encoding: "utf8",
    });
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
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
  const lines = cleaned.split("\n");
  return lines.slice(-40).join("\n");
}

function bootLogPath() {
  try {
    return path.join(app.getPath("userData"), BOOT_LOG_FILE);
  } catch {
    return path.join(getDataDir(), BOOT_LOG_FILE);
  }
}

function writeBootLog(message) {
  try {
    const file = bootLogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const stamp = new Date().toISOString();
    fs.writeFileSync(
      file,
      `[${stamp}] ${message}\n\n--- last server output ---\n${trimLog(serverLog)}\n`,
      "utf8",
    );
  } catch {
    // ignore
  }
}

function failureDetails(headline) {
  const parts = [headline];
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
      "No server output was captured. Port 3901 may already be in use, or reinstall Arrs Hub Companion from Drive/GitHub.",
    );
  }
  parts.push(`Boot log: ${bootLogPath()}`);
  return parts.join("\n\n");
}

/** Kill anything still listening on the companion port (orphaned prior boot). */
function freeCompanionPort(port) {
  if (process.platform !== "win32") return;
  try {
    const netstat = spawnSync("netstat", ["-ano", "-p", "tcp"], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 10000,
    });
    const out = String(netstat.stdout || "");
    const needle = `:${port}`;
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes(needle) || !line.includes("LISTENING")) continue;
      const parts = line.trim().split(/\s+/);
      const pid = Number(parts[parts.length - 1]);
      if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) {
        pids.add(pid);
      }
    }
    for (const pid of pids) {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        timeout: 15000,
        encoding: "utf8",
      });
      appendServerLog(`Freed port ${port} (killed pid ${pid})\n`);
    }
  } catch {
    // ignore
  }
}

function waitForHealth(port, timeoutMs = HEALTH_TIMEOUT_MS) {
  const url = `http://127.0.0.1:${port}/api/health`;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const fail = (message) => {
      const details = failureDetails(message);
      writeBootLog(details);
      reject(new Error(details));
    };

    const tryOnce = () => {
      if (serverExit) {
        fail("Companion server stopped before it became ready.");
        return;
      }
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else retry();
      });
      req.on("error", retry);
      req.setTimeout(1500, () => {
        req.destroy();
        retry();
      });
    };

    const retry = () => {
      if (serverExit) {
        fail("Companion server stopped before it became ready.");
        return;
      }
      if (Date.now() - started > timeoutMs) {
        fail(`Companion did not become ready at ${url}`);
        return;
      }
      setTimeout(tryOnce, 250);
    };

    tryOnce();
  });
}

function startServer() {
  serverExit = null;
  serverLog = "";
  const root = getCompanionRoot();
  const dataDir = getDataDir();
  fs.mkdirSync(dataDir, { recursive: true });

  companionPort =
    process.env.ARRS_COMPANION_PORT ||
    process.env.PORT ||
    readConfiguredPort(dataDir);

  const serverScript = path.join(root, "companion", "server.mjs");
  if (!fs.existsSync(serverScript)) {
    throw new Error(`Companion server missing at ${serverScript}`);
  }

  const expressDir = path.join(root, "node_modules", "express");
  const lanUtils = path.join(root, "server", "lan-utils.mjs");
  if (!fs.existsSync(expressDir)) {
    throw new Error(
      `Companion dependencies missing (${expressDir}). Reinstall Arrs Hub Companion.`,
    );
  }
  if (!fs.existsSync(lanUtils)) {
    throw new Error(
      `Companion package incomplete (missing lan-utils.mjs). Reinstall Arrs Hub Companion 1.3.39+.`,
    );
  }

  freeCompanionPort(companionPort);

  const node = resolveNodeBinary();
  if (!node) {
    throw new Error("Could not start companion (no Node runtime).");
  }

  const env = {
    ...process.env,
    ARRS_COMPANION_ROOT: root,
    ARRS_COMPANION_DATA_DIR: dataDir,
    ARRS_COMPANION_PORT: companionPort,
    ARRS_COMPANION_BIND:
      process.env.ARRS_COMPANION_BIND || process.env.ARRS_COMPANION_HOST || "0.0.0.0",
    ARRS_COMPANION_VERSION: app.getVersion(),
  };

  if (node.electronAsNode) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }

  appendServerLog(
    `Starting companion server\n  root=${root}\n  data=${dataDir}\n  port=${companionPort}\n  script=${serverScript}\n`,
  );

  serverProcess = spawn(node.bin, [serverScript], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  serverProcess.stdout?.on("data", (chunk) => appendServerLog(chunk));
  serverProcess.stderr?.on("data", (chunk) => appendServerLog(chunk));

  serverProcess.on("error", (err) => {
    serverExit = { error: err };
    appendServerLog(`spawn error: ${err?.message || err}\n`);
  });

  serverProcess.on("exit", (code, signal) => {
    serverExit = { code, signal };
    appendServerLog(`exit code=${code} signal=${signal}\n`);
    serverProcess = null;
  });
}

function settingsPath() {
  return path.join(getDataDir(), "companion-settings.json");
}

function readCompanionSettings() {
  const file = settingsPath();
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    }
  } catch {
    // ignore
  }
  return {};
}

function saveHubUrl(hubUrl) {
  const file = settingsPath();
  const current = readCompanionSettings();
  const next = {
    ...current,
    hubUrl: String(hubUrl || "").trim(),
  };
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function promptHubUrlDialog(defaultValue = "") {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(String(value || "").trim());
    };

    const win = new BrowserWindow({
      width: 520,
      height: 220,
      show: false,
      alwaysOnTop: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: "Set Arrs Hub URL",
      autoHideMenuBar: true,
      icon: loadIcon().isEmpty() ? undefined : loadIcon(),
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    });

    const channel = `hub-url-prompt:${win.id}`;
    ipcMain.once(channel, (_event, value) => {
      finish(value);
      if (!win.isDestroyed()) win.close();
    });

    win.on("closed", () => finish(""));

    const safeDefault = String(defaultValue)
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'");

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:Segoe UI,sans-serif;margin:0;padding:20px;background:#1a1d24;color:#e8eaed">
<p style="margin:0 0 8px">LAN URL of Arrs Hub on your Plex PC</p>
<p style="margin:0 0 12px;font-size:12px;color:#9aa0a6">Example: http://10.0.0.50:3000</p>
<input id="url" type="text" style="width:100%;box-sizing:border-box;padding:10px;font-size:14px;margin-bottom:16px" />
<div style="text-align:right">
<button id="cancel" type="button" style="margin-right:8px;padding:8px 16px">Cancel</button>
<button id="ok" type="button" style="padding:8px 16px;background:#5b8def;color:#fff;border:none;cursor:pointer">Save</button>
</div>
<script>
const { ipcRenderer } = require('electron');
const channel = ${JSON.stringify(channel)};
const input = document.getElementById('url');
input.value = '${safeDefault}';
function submit(value) { ipcRenderer.send(channel, value); }
document.getElementById('ok').onclick = () => submit(input.value.trim());
document.getElementById('cancel').onclick = () => submit('');
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submit(input.value.trim());
  if (e.key === 'Escape') submit('');
});
input.focus(); input.select();
</script></body></html>`;

    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).then(() => {
      win.show();
      win.focus();
    });
  });
}

function companionApiRequest(apiPath, method = "GET", body = null) {
  const settings = readCompanionSettings();
  const apiKey = settings.apiKey || "";
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : "";
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: Number(companionPort),
        path: apiPath,
        method,
        headers: {
          "Content-Type": "application/json",
          "X-Arrs-Companion-Key": apiKey,
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(data || "{}") });
          } catch {
            resolve({ status: res.statusCode, json: {} });
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error("Companion API timed out"));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function registerWithHubNow() {
  try {
    const { status, json } = await companionApiRequest("/api/register-hub", "POST");
    if (status === 200 && json.ok) {
      dialog.showMessageBox({
        type: "info",
        title: "Registered with Arrs Hub",
        message: json.message || "Companion registered successfully.",
      });
    } else {
      dialog.showMessageBox({
        type: "warning",
        title: "Registration",
        message: json.message || json.error || `HTTP ${status}`,
      });
    }
  } catch (err) {
    dialog.showMessageBox({
      type: "error",
      title: "Registration failed",
      message: String(err?.message || err),
    });
  }
  refreshTrayMenu();
}

async function setHubUrlFromTray() {
  const settings = readCompanionSettings();
  const entered = await promptHubUrlDialog(
    settings.hubUrl || "http://10.0.0.50:3000",
  );
  if (!entered) return;
  saveHubUrl(entered);
  try {
    await companionApiRequest("/api/settings", "PUT", { hubUrl: entered });
    await companionApiRequest("/api/register-hub", "POST");
  } catch {
    // settings file saved; registration retries on the next loop
  }
  dialog.showMessageBox({
    type: "info",
    title: "Arrs Hub URL saved",
    message: `Hub URL: ${entered}\nCompanion will register automatically.`,
  });
  refreshTrayMenu();
}

function toggleStartup() {
  openAtLoginEnabled = toggleOpenAtLogin(
    app,
    LOGIN_SETTINGS_FILE,
    APP_DISPLAY_NAME,
  );
  refreshTrayMenu();
}

function registrationStatusLabel() {
  const settings = readCompanionSettings();
  if (settings.lastRegisterOk) {
    return `Hub linked · ${settings.hubUrl || "LAN"}`;
  }
  if (settings.hubUrl) {
    return `Hub URL set · waiting for register…`;
  }
  return "Scanning LAN for Arrs Hub (VPN may require manual URL)…";
}

function openSetupInfo() {
  const file = settingsPath();
  let apiKey = "(generated on first run)";
  let port = companionPort;
  let hubUrl = "";
  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (raw.apiKey) apiKey = raw.apiKey;
      if (raw.port) port = String(raw.port);
      if (raw.hubUrl) hubUrl = raw.hubUrl;
    }
  } catch {
    // ignore
  }
  const text = [
    "Arrs Hub Companion setup",
    "",
    "Automatic mode: Companion scans physical LAN adapters (Surfshark/VPN",
    "adapters are skipped). Set Hub URL manually if auto-find fails.",
    "",
    `Hub URL (optional override): ${hubUrl || "(auto-discover on LAN)"}`,
    `API URL: http://<this-PC-LAN-IP>:${port}`,
    `Health: http://127.0.0.1:${port}/api/health`,
    "",
    `Settings file: ${file}`,
    `API key (only needed for manual setup): ${apiKey}`,
  ].join("\n");
  const tmp = path.join(app.getPath("temp"), "arrs-hub-companion-setup.txt");
  fs.writeFileSync(tmp, text, "utf8");
  shell.openPath(tmp);
}

function forceQuit() {
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
  try {
    app.exit(0);
  } catch {
    process.exit(0);
  }
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: `Running on port ${companionPort}`,
      enabled: false,
    },
    {
      label: registrationStatusLabel(),
      enabled: false,
    },
    {
      label: "Register with Arrs Hub now",
      click: () => void registerWithHubNow(),
    },
    {
      label: "Set Arrs Hub URL…",
      click: () => {
        void setHubUrlFromTray();
      },
    },
    {
      label: "Start with Windows",
      type: "checkbox",
      checked: openAtLoginEnabled,
      click: () => toggleStartup(),
    },
    {
      label: "Open health check",
      click: () =>
        shell.openExternal(`http://127.0.0.1:${companionPort}/api/health`),
    },
    {
      label: "Setup info",
      click: () => openSetupInfo(),
    },
    { type: "separator" },
    { label: "Quit", click: () => forceQuit() },
  ]);
}

function createTray() {
  if (tray) {
    try {
      tray.destroy();
    } catch {
      // ignore
    }
    tray = null;
  }
  const icon = trayIcon();
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip(`${APP_DISPLAY_NAME} v${app.getVersion()} · :${companionPort}`);
  tray.setContextMenu(buildTrayMenu());
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(buildTrayMenu());
}

async function boot() {
  openAtLoginEnabled = syncOpenAtLogin(
    app,
    LOGIN_SETTINGS_FILE,
    APP_DISPLAY_NAME,
    true,
  );
  startServer();
  await waitForHealth(companionPort);
  createTray();
  setInterval(() => refreshTrayMenu(), 30_000);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.whenReady().then(() => {
    boot().catch((err) => {
      const { dialog } = require("electron");
      dialog.showErrorBox(
        "Arrs Hub Companion failed to start",
        String(err?.message || err),
      );
      isQuitting = true;
      app.quit();
    });
  });

  app.on("before-quit", () => {
    isQuitting = true;
    stopServer();
  });
}
