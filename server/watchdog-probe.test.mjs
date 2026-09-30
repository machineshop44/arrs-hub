import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { checkHttpAlive } from "./watchdog.mjs";
import { findProcessesByName } from "./restart-windows.mjs";
import { loadWatchdogSettings } from "./watchdog-store.mjs";

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("checkHttpAlive treats any HTTP status as alive", async () => {
  const server = await listen((_req, res) => {
    res.statusCode = 401;
    res.end("nope");
  });
  const { port } = server.address();
  const r = await checkHttpAlive(`http://127.0.0.1:${port}/`, 3000);
  server.close();
  assert.equal(r.up, true);
  assert.match(r.message, /HTTP 401/);
});

test("checkHttpAlive flags an open port that never answers as hung", async () => {
  const sockets = [];
  const server = await listen(() => {});
  server.on("connection", (s) => sockets.push(s));
  const { port } = server.address();
  const r = await checkHttpAlive(`http://127.0.0.1:${port}/`, 800);
  for (const s of sockets) s.destroy();
  server.close();
  assert.equal(r.up, false);
  assert.match(r.message, /hung/);
});

test("findProcessesByName sees the running node process", { skip: process.platform !== "win32" }, async () => {
  const r = await findProcessesByName(["node"]);
  assert.equal(r.ok, true);
  assert.ok(r.running.some((p) => p.pid === process.pid));
});

test("watchdog defaults carry Task Manager process names and drop the Plex Update Service restart", () => {
  const s = loadWatchdogSettings();
  assert.ok(s.services.sonarr.processNames.includes("Sonarr.Console"));
  assert.ok(s.services.drivepool.processNames.includes("DrivePool.Service.Native"));
  assert.notEqual(s.services.plex.windowsService, "PlexUpdateService");
});
