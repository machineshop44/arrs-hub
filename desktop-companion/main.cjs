const { app, Tray, Menu, nativeImage, shell } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

const DEFAULT_PORT = "3901";
const HEALTH_TIMEOUT_MS = 60000;

let tray = null;
let serverProcess = null;
let isQuitting = false;
let serverExit = null;
let companionPort = DEFAULT_PORT;

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
  return {
    ico: path.join(root, "build", "icon.ico"),
    png: path.join(root, "desktop", "icon.png"),
  };
}

function loadIcon() {
  const icons = getIconPaths();
  for (const candidate of [icons.ico, icons.png]) {
    if (candidate && fs.existsSync(candidate)) {
      return nativeImage.createFromPath(candidate);
    }
  }
  return nativeImage.createEmpty();
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

function waitForHealth(port, timeoutMs = HEALTH_TIMEOUT_MS) {
  const url = `http://127.0.0.1:${port}/api/health`;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const fail = (message) => reject(new Error(message));

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

  serverProcess = spawn(node.bin, [serverScript], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  serverProcess.on("error", (err) => {
    serverExit = { error: err };
  });

  serverProcess.on("exit", (code, signal) => {
    serverExit = { code, signal };
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

function promptHubUrl(current = "") {
  const escaped = String(current).replace(/'/g, "''");
  const script = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.Interaction]::InputBox('LAN URL of Arrs Hub on your Plex PC (e.g. http://192.168.1.10:3000)','Arrs Hub Companion','${escaped}')`;
  const result = spawnSync("powershell", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 120000,
  });
  return String(result.stdout || "").trim();
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
  const { dialog } = require("electron");
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
  const { dialog } = require("electron");
  const settings = readCompanionSettings();
  const entered = promptHubUrl(settings.hubUrl || "http://192.168.1.10:3000");
  if (!entered) return;
  saveHubUrl(entered);
  try {
    await companionApiRequest("/api/settings", "PUT", { hubUrl: entered });
  } catch {
    // settings file already saved; server reloads on next register tick
  }
  dialog.showMessageBox({
    type: "info",
    title: "Arrs Hub URL saved",
    message: `Hub URL: ${entered}\nCompanion will register automatically.`,
  });
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
  return "Scanning LAN for Arrs Hub…";
}

function refreshTrayMenu() {
  if (!tray) return;
  createTray();
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
    "Automatic mode: Companion scans your LAN for Arrs Hub on the Plex PC,",
    "registers itself, and wires qBit/SAB restarts — no manual Port Watch setup.",
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
      click: () => void setHubUrlFromTray(),
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
  const icon = loadIcon();
  tray = new Tray(
    icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }),
  );
  tray.setToolTip(`Arrs Hub Companion v${app.getVersion()} · :${companionPort}`);
  tray.setContextMenu(buildTrayMenu());
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(buildTrayMenu());
}

async function boot() {
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
