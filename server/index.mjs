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
  wakePcNow,
} from "./watchdog.mjs";
import {
  discoverWorkoutDays,
  getPlexAuthStatus,
  getWorkoutConfig,
  listClients,
  listLibraries,
  logoutPlex,
  playWorkoutDay,
  pollPlexLogin,
  publicWorkoutSettings,
  startPlexLogin,
  streamWorkoutMedia,
  testPlexConnection,
  updateWorkoutConfig,
} from "./plex.mjs";
import {
  getTautulliActivity,
  proxyTautulliImage,
  publicTautulliSettings,
  updateTautulliSettings,
} from "./tautulli.mjs";
import {
  publicIntegrationsSettings,
  updateIntegrationsSettings,
} from "./integrations.mjs";
import {
  approveOmbiRequest,
  getHubStatusSummary,
  getOmbiPendingRequests,
} from "./activity.mjs";
import {
  getPlexUpdateJob,
  getPlexUpdateStatus,
  startPlexUpdateJob,
} from "./plex-update.mjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.ARRS_HUB_ROOT
  ? path.resolve(process.env.ARRS_HUB_ROOT)
  : path.resolve(__dirname, "..");
const DIST = process.env.ARRS_HUB_DIST
  ? path.resolve(process.env.ARRS_HUB_DIST)
  : path.join(ROOT, "dist");
const desktopMode = process.env.ARRS_HUB_DESKTOP === "1";
const PORT = Number(
  process.env.ARRS_HUB_PORT ||
    process.env.PORT ||
    process.env.ARRS_HUB_SYNC_PORT ||
    (desktopMode ? 3000 : 3847),
);
/**
 * Bind address. Default 0.0.0.0 so phones/tablets on LAN (and port-forwarded
 * remote clients) can reach Workouts + watchdog status APIs. Opt into
 * localhost-only with ARRS_HUB_BIND=127.0.0.1 (ARRS_HUB_HOST also accepted).
 */
const HOST =
  String(
    process.env.ARRS_HUB_BIND || process.env.ARRS_HUB_HOST || "0.0.0.0",
  ).trim() || "0.0.0.0";

/**
 * Packaged Electron unpacks server/ outside the asar, so `../package.json`
 * next to server may be missing. Prefer env from desktop main, then file
 * candidates, then a safe fallback — never crash the hub on missing pkg.
 */
function loadPackageInfo() {
  const fromEnvVersion = String(process.env.ARRS_HUB_VERSION || "").trim();
  const fromEnvName = String(process.env.ARRS_HUB_NAME || "").trim();

  const candidates = [
    path.join(ROOT, "package.json"),
    path.join(__dirname, "..", "package.json"),
    // Packaged: package.json may still live inside app.asar
    process.env.ARRS_HUB_APP_PATH
      ? path.join(process.env.ARRS_HUB_APP_PATH, "package.json")
      : null,
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const pkg = require(candidate);
      return {
        name: fromEnvName || pkg.name || "arrs-hub",
        version: fromEnvVersion || pkg.version || "unknown",
      };
    } catch {
      // try next candidate
    }
  }

  return {
    name: fromEnvName || "arrs-hub",
    version: fromEnvVersion || "unknown",
  };
}

const packageJson = loadPackageInfo();

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, version: packageJson.version, name: packageJson.name });
});

app.get("/api/version", (_req, res) => {
  res.json({
    name: "Arrs Hub",
    version: packageJson.version,
    major: "v1",
  });
});

app.get("/api/integrations/settings", (_req, res) => {
  res.json({ settings: publicIntegrationsSettings() });
});

app.put("/api/integrations/settings", (req, res) => {
  try {
    const settings = updateIntegrationsSettings(req.body ?? {});
    res.json({ ok: true, settings: publicIntegrationsSettings(settings) });
  } catch (err) {
    res.status(400).json({ error: err.message || String(err) });
  }
});

app.post("/api/status/summary", async (req, res) => {
  try {
    const summary = await getHubStatusSummary({
      urls: req.body?.urls ?? {},
    });
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.get("/api/activity/ombi/pending", async (_req, res) => {
  try {
    const result = await getOmbiPendingRequests({});
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.post("/api/activity/ombi/pending", async (req, res) => {
  try {
    const result = await getOmbiPendingRequests({
      urls: req.body?.urls ?? {},
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.post("/api/activity/ombi/approve", async (req, res) => {
  try {
    const result = await approveOmbiRequest({
      type: req.body?.type,
      id: req.body?.id,
      urls: req.body?.urls ?? {},
    });
    res.json(result);
  } catch (err) {
    const status = Number(err?.status) || 500;
    res.status(status).json({ error: err.message || String(err) });
  }
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
    // Same shape as GET /api/watchdog/status so the panel can apply settings + live pcs
    res.json({ ok: true, ...getWatchStatus() });
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

app.post("/api/watchdog/wol", async (req, res) => {
  try {
    const pcId = String(req.body?.pcId || "");
    const result = await wakePcNow(pcId);
    res.json({ ok: true, ...result, ...getWatchStatus() });
  } catch (err) {
    res.status(400).json({ error: err.message || String(err) });
  }
});

app.get("/api/workouts/settings", (_req, res) => {
  res.json({ settings: publicWorkoutSettings() });
});

app.put("/api/workouts/settings", (req, res) => {
  try {
    const body = req.body ?? {};
    const current = getWorkoutConfig();
    const settings = updateWorkoutConfig({
      plexBaseUrl: body.plexBaseUrl,
      plexToken: pickApiKey(body.plexToken, current.plexToken),
      librarySectionId: body.librarySectionId,
      matchMode: body.matchMode,
      showTitle: body.showTitle,
      seasonNumber:
        body.seasonNumber === undefined || body.seasonNumber === null
          ? current.seasonNumber
          : Number(body.seasonNumber) || 1,
      warmupEpisode:
        body.warmupEpisode === undefined || body.warmupEpisode === null
          ? current.warmupEpisode
          : Number(body.warmupEpisode) || 2,
      firstDayEpisode:
        body.firstDayEpisode === undefined || body.firstDayEpisode === null
          ? current.firstDayEpisode
          : Number(body.firstDayEpisode) || 3,
      warmupTitle: body.warmupTitle,
      dayTitlePattern: body.dayTitlePattern,
      clientMachineId: body.clientMachineId,
      clientName: body.clientName,
      dayCount: Number(body.dayCount) || current.dayCount,
    });
    res.json({
      ok: true,
      settings: publicWorkoutSettings(settings),
    });
  } catch (err) {
    res.status(400).json({ error: err.message || String(err) });
  }
});

app.get("/api/workouts/plex/auth", async (_req, res) => {
  try {
    const status = await getPlexAuthStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.post("/api/workouts/plex/auth/start", async (_req, res) => {
  try {
    const started = await startPlexLogin();
    res.json({ ok: true, ...started });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.get("/api/workouts/plex/auth/poll", async (req, res) => {
  try {
    const pinId = String(req.query?.pinId || "");
    const result = await pollPlexLogin(pinId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || String(err) });
  }
});

app.post("/api/workouts/plex/auth/logout", async (_req, res) => {
  try {
    const result = await logoutPlex();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
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

/**
 * Absolute base the client used to reach the hub (for proxied media URLs).
 * Prefers X-Forwarded-* when present (port-forward / reverse proxy).
 */
function requestPublicBaseUrl(req) {
  const xfProto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim();
  const xfHost = String(req.headers["x-forwarded-host"] || "")
    .split(",")[0]
    .trim();
  const host = xfHost || String(req.headers.host || "").trim();
  if (!host) return "";
  const proto = xfProto || (req.secure ? "https" : "http");
  return `${proto}://${host}`;
}

app.get("/api/workouts/media/:ratingKey", async (req, res) => {
  try {
    await streamWorkoutMedia(req, res, req.params.ratingKey);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || String(err) });
    }
  }
});

app.post("/api/workouts/play", async (req, res) => {
  try {
    const day = Number(req.body?.day);
    const clientMachineId =
      typeof req.body?.clientMachineId === "string"
        ? req.body.clientMachineId
        : undefined;
    const skipWarmup = Boolean(req.body?.skipWarmup);
    const publicBaseUrl = requestPublicBaseUrl(req);
    const result = await playWorkoutDay(day, undefined, {
      clientMachineId,
      skipWarmup,
      publicBaseUrl,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.get("/api/tautulli/settings", (_req, res) => {
  res.json({ settings: publicTautulliSettings() });
});

app.put("/api/tautulli/settings", (req, res) => {
  try {
    const body = req.body ?? {};
    const settings = updateTautulliSettings({
      baseUrl: body.baseUrl,
      apiKey: body.apiKey,
    });
    res.json({ ok: true, settings: publicTautulliSettings(settings) });
  } catch (err) {
    res.status(400).json({ error: err.message || String(err) });
  }
});

app.get("/api/tautulli/activity", async (_req, res) => {
  try {
    const settings = publicTautulliSettings();
    if (!settings.apiKeySet) {
      res.status(400).json({
        error:
          "Tautulli API key not set. Add it in hub Settings → Tautulli or Streams setup (Tautulli → Settings → Web Interface → API).",
        code: "TAUTULLI_NOT_CONFIGURED",
        settings,
      });
      return;
    }
    const activity = await getTautulliActivity();
    res.json({ ok: true, settings, activity });
  } catch (err) {
    const status = err?.code === "TAUTULLI_NOT_CONFIGURED" ? 400 : 500;
    res.status(status).json({
      error: err.message || String(err),
      code: err?.code || undefined,
      settings: publicTautulliSettings(),
    });
  }
});

app.get("/api/tautulli/image", async (req, res) => {
  try {
    const img = typeof req.query.img === "string" ? req.query.img : "";
    const ratingKey =
      typeof req.query.rating_key === "string"
        ? req.query.rating_key
        : typeof req.query.ratingKey === "string"
          ? req.query.ratingKey
          : "";
    const width = req.query.width;
    const height = req.query.height;
    const fallback =
      typeof req.query.fallback === "string" ? req.query.fallback : "poster";

    const { contentType, buffer } = await proxyTautulliImage({
      img: img || undefined,
      ratingKey: ratingKey || undefined,
      width,
      height,
      fallback,
    });
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "private, max-age=300");
    res.send(buffer);
  } catch (err) {
    const status = err?.code === "TAUTULLI_NOT_CONFIGURED" ? 400 : 502;
    res.status(status).json({ error: err.message || String(err) });
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

/**
 * Plex Media Server update check / install (hub on PMS PC).
 * Mobile + desktop share these; install uses PMS /updater/* APIs.
 */
app.get("/api/plex/update-status", async (req, res) => {
  try {
    const refresh =
      req.query.refresh === "1" ||
      req.query.refresh === "true" ||
      req.query.refresh === "yes";
    const status = await getPlexUpdateStatus({ refresh });
    res.json(status);
  } catch (err) {
    res.status(500).json({
      ok: false,
      installedVersion: null,
      latestVersion: null,
      updateAvailable: false,
      error: err.message || String(err),
    });
  }
});

app.post("/api/plex/update", async (req, res) => {
  try {
    const job = startPlexUpdateJob({
      download: req.body?.download,
      apply: req.body?.apply,
      tonight: req.body?.tonight,
    });
    res.status(202).json({ ok: true, job });
  } catch (err) {
    const status = err?.code === "JOB_IN_PROGRESS" ? 409 : 500;
    res.status(status).json({ ok: false, error: err.message || String(err) });
  }
});

app.get("/api/plex/update-job", (_req, res) => {
  res.json({ ok: true, job: getPlexUpdateJob() });
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
  const includeQualityDefinition =
    req.body?.includeQualityDefinition !== false;
  const includeQualityProfiles = req.body?.includeQualityProfiles !== false;

  try {
    const settings = loadSyncSettings();
    const selected = new Set(settings.selectedPresets ?? []);
    const presets = SYNC_PRESETS.filter((preset) => selected.has(preset.id));
    if (presets.length === 0) {
      res.status(400).json({ error: "Select at least one TRaSH profile preset." });
      return;
    }

    const yaml = buildRecyclarrYaml(settings, presets, {
      includeQualityDefinition: preview ? true : includeQualityDefinition,
      includeQualityProfiles: preview ? true : includeQualityProfiles,
    });

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

app.listen(PORT, HOST, () => {
  const localUrl = `http://127.0.0.1:${PORT}`;
  const bindNote =
    HOST === "0.0.0.0" || HOST === "::"
      ? `${localUrl} (LAN-reachable on all interfaces)`
      : `http://${HOST}:${PORT}`;
  console.log(
    desktopMode
      ? `Arrs Hub desktop server listening on ${bindNote}`
      : `Arrs Hub sync server listening on ${bindNote}`,
  );
  try {
    startWatchdog();
  } catch (err) {
    console.error("Watchdog failed to start:", err?.message || err);
  }
}).on("error", (err) => {
  if (err?.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} is already in use. Close the other Arrs Hub window/process, or set ARRS_HUB_PORT (or PORT) to a free port, then start again.`,
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
