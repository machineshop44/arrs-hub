import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import {
  loadCompanionSettings,
  publicCompanionSettings,
  saveCompanionSettings,
  verifyCompanionApiKey,
} from "./companion-store.mjs";
import { restartServiceOrExe, checkLocalServiceStatus } from "../server/restart-windows.mjs";
import {
  guessBroadcastAddress,
  normalizeMac,
  sendWakeOnLan,
} from "../server/wol.mjs";
import {
  runHubRegistration,
  startHubRegistrationLoop,
} from "./hub-client.mjs";
import {
  getCompanionAppUpdateJob,
  startCompanionAppUpdate,
  supportedCompanionUpdateIds,
} from "./app-update.mjs";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.ARRS_COMPANION_ROOT
  ? path.resolve(process.env.ARRS_COMPANION_ROOT)
  : path.resolve(__dirname, "..");

if (process.env.ARRS_COMPANION_DATA_DIR) {
  process.env.ARRS_COMPANION_DATA_DIR = path.resolve(
    process.env.ARRS_COMPANION_DATA_DIR,
  );
}

function readApiKey(req) {
  const header = req.headers["x-arrs-companion-key"];
  if (typeof header === "string" && header.trim()) return header.trim();
  const bodyKey = req.body?.apiKey;
  if (typeof bodyKey === "string" && bodyKey.trim()) return bodyKey.trim();
  return "";
}

function requireAuth(req, res, next) {
  const settings = loadCompanionSettings();
  const key = readApiKey(req);
  if (!verifyCompanionApiKey(key, settings.apiKey)) {
    res.status(401).json({ error: "Invalid companion API key." });
    return;
  }
  next();
}

const app = express();
app.use(express.json({ limit: "256kb" }));

app.get("/api/health", (_req, res) => {
  const settings = loadCompanionSettings();
  res.json({
    ok: true,
    product: "Arrs Hub Companion",
    version: process.env.ARRS_COMPANION_VERSION || "1.0.0",
    name: settings.name,
    bind: settings.bind,
    port: settings.port,
  });
});

app.get("/api/settings", requireAuth, (_req, res) => {
  res.json({ settings: publicCompanionSettings(loadCompanionSettings()) });
});

app.post("/api/register-hub", requireAuth, async (_req, res) => {
  try {
    const result = await runHubRegistration();
    res.json(result);
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.put("/api/settings", requireAuth, (req, res) => {
  try {
    const current = loadCompanionSettings();
    const body = req.body ?? {};
    const next = saveCompanionSettings({
      ...current,
      name: body.name !== undefined ? String(body.name || "").trim() : current.name,
      hubUrl: body.hubUrl !== undefined ? String(body.hubUrl || "").trim() : current.hubUrl,
      autoDiscoverHub:
        body.autoDiscoverHub !== undefined
          ? Boolean(body.autoDiscoverHub)
          : current.autoDiscoverHub,
    });
    res.json({ ok: true, settings: publicCompanionSettings(next) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/restart", requireAuth, async (req, res) => {
  try {
    const body = req.body ?? {};
    const result = await restartServiceOrExe({
      windowsService: body.windowsService,
      exePath: body.exePath,
      exeArgs: body.exeArgs,
      exeCwd: body.exeCwd,
    });
    res.json({ ok: result.ok, message: result.message });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.post("/api/service-status", requireAuth, async (req, res) => {
  try {
    const body = req.body ?? {};
    const result = await checkLocalServiceStatus({
      windowsService: body.windowsService,
      exePath: body.exePath,
      exeArgs: body.exeArgs,
      exeCwd: body.exeCwd,
      processHints: Array.isArray(body.processHints) ? body.processHints : [],
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({
      ok: false,
      running: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.get("/api/local-app-versions", requireAuth, async (_req, res) => {
  try {
    const { getLocalAppVersions } = await import("./local-app-versions.mjs");
    const result = await getLocalAppVersions();
    res.json(result);
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      apps: [],
    });
  }
});

app.get("/api/app-update", requireAuth, (req, res) => {
  res.json({
    ok: true,
    supported: supportedCompanionUpdateIds(),
    job: getCompanionAppUpdateJob(req.query?.id),
  });
});

app.post("/api/app-update", requireAuth, (req, res) => {
  try {
    const job = startCompanionAppUpdate(req.body ?? {});
    res.json({ ok: true, job });
  } catch (err) {
    const code = err?.code;
    const status =
      code === "JOB_IN_PROGRESS"
        ? 409
        : code === "UNSUPPORTED" || code === "BAD_REQUEST"
          ? 400
          : 500;
    res.status(status).json({
      error: err instanceof Error ? err.message : String(err),
      code: code || undefined,
      job: getCompanionAppUpdateJob(req.body?.id),
    });
  }
});

app.post("/api/wol", requireAuth, async (req, res) => {
  try {
    const mac = normalizeMac(req.body?.mac);
    if (!mac) {
      res.status(400).json({ error: "MAC address must look like AA:BB:CC:DD:EE:FF" });
      return;
    }
    const host = String(req.body?.host || "").trim();
    const broadcast = guessBroadcastAddress(host) || "255.255.255.255";
    const result = await sendWakeOnLan(mac, { broadcastAddress: broadcast });
    res.json({
      ok: true,
      mac: result.mac,
      broadcast,
      message: `Wake-on-LAN sent to ${result.mac} via ${broadcast}`,
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

const settings = loadCompanionSettings();
const PORT = Number(
  process.env.ARRS_COMPANION_PORT || process.env.PORT || settings.port || 3901,
);
const HOST = process.env.ARRS_COMPANION_BIND || settings.bind || "0.0.0.0";

const server = app.listen(PORT, HOST, () => {
  console.log(
    `Arrs Hub Companion listening on http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT}`,
  );
  try {
    startHubRegistrationLoop();
  } catch (err) {
    console.error(
      "Hub registration loop failed to start:",
      err instanceof Error ? err.message : err,
    );
  }
});
server.on("error", (err) => {
  const code = err && typeof err === "object" ? err.code : "";
  if (code === "EADDRINUSE") {
    console.error(
      `Companion server failed: port ${PORT} is already in use. Close the other Arrs Hub Companion / process, then retry.`,
    );
  } else {
    console.error("Companion server failed:", err);
  }
  process.exit(1);
});
