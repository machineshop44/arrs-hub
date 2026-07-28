import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRecyclarrYaml,
  loadSyncSettings,
  saveSyncSettings,
} from "./config.mjs";
import { SYNC_PRESETS } from "./presets.mjs";
import {
  ensureRecyclarrInstalled,
  getInstalledVersion,
  isRecyclarrInstalled,
  runSync,
} from "./recyclarr.mjs";
import {
  getWatchStatus,
  setWatchTargets,
  startWatchdog,
  updateWatchdogSettings,
  runWatchCycle,
  testDiscordWebhook,
} from "./watchdog.mjs";
import {
  discoverWorkoutDays,
  getWorkoutConfig,
  listClients,
  listLibraries,
  playWorkoutDay,
  testPlexConnection,
  updateWorkoutConfig,
} from "./plex.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const desktopMode = process.env.ARRS_HUB_DESKTOP === "1";
const PORT = Number(
  process.env.ARRS_HUB_SYNC_PORT || (desktopMode ? 3000 : 3847),
);

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/watchdog/status", (_req, res) => {
  res.json(getWatchStatus());
});

app.put("/api/watchdog/targets", (req, res) => {
  try {
    setWatchTargets(req.body?.targets ?? []);
    res.json({ ok: true, ...getWatchStatus() });
  } catch (err) {
    res.status(400).json({ error: err.message || String(err) });
  }
});

app.put("/api/watchdog/settings", (req, res) => {
  try {
    updateWatchdogSettings(req.body ?? {});
    res.json({ ok: true, settings: getWatchStatus().settings });
  } catch (err) {
    res.status(400).json({ error: err.message || String(err) });
  }
});

app.post("/api/watchdog/discord-test", async (_req, res) => {
  try {
    const result = await testDiscordWebhook();
    if (!result.ok) {
      res.status(400).json({ error: result.message });
      return;
    }
    res.json({ ok: true, message: result.message });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.post("/api/watchdog/check", async (_req, res) => {
  try {
    const status = await runWatchCycle();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.get("/api/workouts/settings", (_req, res) => {
  const settings = getWorkoutConfig();
  res.json({
    settings: {
      ...settings,
      plexToken: settings.plexToken ? maskKey(settings.plexToken) : "",
      plexTokenSet: Boolean(settings.plexToken),
    },
  });
});

app.put("/api/workouts/settings", (req, res) => {
  try {
    const body = req.body ?? {};
    const current = getWorkoutConfig();
    const settings = updateWorkoutConfig({
      plexBaseUrl: body.plexBaseUrl,
      plexToken: pickApiKey(body.plexToken, current.plexToken),
      librarySectionId: body.librarySectionId,
      warmupTitle: body.warmupTitle,
      dayTitlePattern: body.dayTitlePattern,
      clientMachineId: body.clientMachineId,
      clientName: body.clientName,
      dayCount: Number(body.dayCount) || current.dayCount,
    });
    res.json({
      ok: true,
      settings: {
        ...settings,
        plexToken: settings.plexToken ? maskKey(settings.plexToken) : "",
        plexTokenSet: Boolean(settings.plexToken),
      },
    });
  } catch (err) {
    res.status(400).json({ error: err.message || String(err) });
  }
});

app.get("/api/workouts/libraries", async (_req, res) => {
  try {
    const libraries = await listLibraries();
    res.json({ libraries });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.get("/api/workouts/clients", async (_req, res) => {
  try {
    const clients = await listClients();
    res.json({ clients });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.get("/api/workouts/discover", async (_req, res) => {
  try {
    const identity = await testPlexConnection();
    const discovery = await discoverWorkoutDays();
    res.json({ ok: true, identity, ...discovery });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.post("/api/workouts/play", async (req, res) => {
  try {
    const day = Number(req.body?.day);
    const result = await playWorkoutDay(day);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.get("/api/sync/presets", (_req, res) => {
  res.json({ presets: SYNC_PRESETS });
});

app.get("/api/sync/settings", (_req, res) => {
  const settings = loadSyncSettings();
  res.json({
    settings: {
      ...settings,
      sonarr: {
        ...settings.sonarr,
        apiKey: settings.sonarr.apiKey ? maskKey(settings.sonarr.apiKey) : "",
        apiKeySet: Boolean(settings.sonarr.apiKey),
      },
      radarr: {
        ...settings.radarr,
        apiKey: settings.radarr.apiKey ? maskKey(settings.radarr.apiKey) : "",
        apiKeySet: Boolean(settings.radarr.apiKey),
      },
    },
  });
});

app.put("/api/sync/settings", (req, res) => {
  try {
    const current = loadSyncSettings();
    const body = req.body ?? {};

    const next = {
      selectedPresets: Array.isArray(body.selectedPresets)
        ? body.selectedPresets
        : current.selectedPresets,
      sonarr: {
        enabled: body.sonarr?.enabled ?? current.sonarr.enabled,
        baseUrl: body.sonarr?.baseUrl?.trim() || current.sonarr.baseUrl,
        apiKey: pickApiKey(body.sonarr?.apiKey, current.sonarr.apiKey),
      },
      radarr: {
        enabled: body.radarr?.enabled ?? current.radarr.enabled,
        baseUrl: body.radarr?.baseUrl?.trim() || current.radarr.baseUrl,
        apiKey: pickApiKey(body.radarr?.apiKey, current.radarr.apiKey),
      },
    };

    saveSyncSettings(next);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message || String(err) });
  }
});

app.get("/api/sync/status", async (_req, res) => {
  try {
    const installed = isRecyclarrInstalled();
    const version = installed ? await getInstalledVersion() : null;
    res.json({
      server: true,
      recyclarrInstalled: installed,
      recyclarrVersion: version,
      gitHint:
        "Recyclarr requires Git for Windows. Install from https://git-scm.com if sync fails.",
    });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.post("/api/sync/install", async (_req, res) => {
  try {
    const result = await ensureRecyclarrInstalled();
    const version = await getInstalledVersion();
    res.json({ ...result, version });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.post("/api/sync/run", async (req, res) => {
  const preview = Boolean(req.body?.preview);
  const wantsStream = req.body?.stream !== false;

  try {
    const settings = loadSyncSettings();
    const selected = new Set(settings.selectedPresets ?? []);
    const presets = SYNC_PRESETS.filter((preset) => selected.has(preset.id));
    if (presets.length === 0) {
      res.status(400).json({ error: "Select at least one TRaSH profile preset." });
      return;
    }

    const yaml = buildRecyclarrYaml(settings, presets);

    if (!wantsStream) {
      const result = await runSync(yaml, { preview, settings });
      res.json({
        ok: true,
        preview,
        stdout: result.stdout,
        stderr: result.stderr,
        summary: result.summary || "",
      });
      return;
    }

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const send = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send("status", {
      message: preview
        ? "Starting preview…"
        : "Starting sync…",
    });

    try {
      const result = await runSync(yaml, {
        preview,
        settings,
        onStatus: (message) => send("status", { message }),
        onOutput: (chunk) => send("log", { chunk }),
      });
      send("done", {
        ok: true,
        preview,
        stdout: result.stdout,
        stderr: result.stderr,
        summary: result.summary || "",
      });
    } catch (err) {
      send("done", {
        ok: false,
        preview,
        error: err.message || String(err),
        stdout: err.stdout || "",
        stderr: err.stderr || "",
      });
    }
    res.end();
  } catch (err) {
    if (res.headersSent) {
      res.write(
        `event: done\ndata: ${JSON.stringify({
          ok: false,
          error: err.message || String(err),
        })}\n\n`,
      );
      res.end();
      return;
    }
    res.status(500).json({
      error: err.message || String(err),
      stdout: err.stdout || "",
      stderr: err.stderr || "",
    });
  }
});

process.title = "arrs-hub-server";

if (desktopMode && fs.existsSync(DIST)) {
  app.use(express.static(DIST));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(DIST, "index.html"));
  });
}

app.listen(PORT, "127.0.0.1", () => {
  console.log(
    desktopMode
      ? `Arrs Hub desktop server listening on http://127.0.0.1:${PORT}`
      : `Arrs Hub sync server listening on http://127.0.0.1:${PORT}`,
  );
  try {
    startWatchdog();
  } catch (err) {
    console.error("Watchdog failed to start:", err?.message || err);
  }
}).on("error", (err) => {
  if (err?.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} is already in use. Close the other Arrs Hub window/process, then start again.`,
    );
    process.exit(1);
  }
  console.error("Server failed to listen:", err);
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});

function maskKey(key) {
  if (!key) return "";
  if (key.length <= 8) return "••••••••";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function pickApiKey(incoming, current) {
  if (typeof incoming !== "string") return current;
  const trimmed = incoming.trim();
  if (!trimmed) return current;
  if (trimmed.includes("…") || trimmed.includes("•")) return current;
  return trimmed;
}
