/**
 * Detect FileFlows Server and/or processing Node (client) on this PC.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SERVER_PORT = 19200;
const NODE_API_PORTS = [19200, 5000, 5001];

function userProfile() {
  return process.env.USERPROFILE || os.homedir();
}

function appData() {
  return process.env.APPDATA || path.join(userProfile(), "AppData", "Roaming");
}

function localAppData() {
  return (
    process.env.LOCALAPPDATA ||
    path.join(userProfile(), "AppData", "Local")
  );
}

function programFiles() {
  return process.env["ProgramFiles"] || "C:\\Program Files";
}

function firstExisting(paths) {
  for (const p of paths) {
    if (p && fs.existsSync(p)) return p;
  }
  return "";
}

function queryWindowsService(name) {
  if (process.platform !== "win32" || !name) return null;
  try {
    const result = spawnSync("sc.exe", ["query", name], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 5000,
    });
    const out = `${result.stdout || ""}\n${result.stderr || ""}`;
    if (result.status !== 0 && !/STATE\s*:/i.test(out)) return null;
    if (/FAILED\s+1060/i.test(out) || /does not exist/i.test(out)) return null;
    const running = /RUNNING/i.test(out);
    const stopped = /STOPPED/i.test(out);
    if (!running && !stopped && !/STATE\s*:/i.test(out)) return null;
    return { name, running, stopped };
  } catch {
    return null;
  }
}

function findService(candidates) {
  for (const name of candidates) {
    const hit = queryWindowsService(name);
    if (hit) return hit.name;
  }
  return "";
}

function serverDllCandidates() {
  return [
    path.join(appData(), "FileFlows", "Server", "FileFlows.Server.dll"),
    path.join(localAppData(), "FileFlows", "Server", "FileFlows.Server.dll"),
    path.join(programFiles(), "FileFlows", "Server", "FileFlows.Server.dll"),
    path.join(programFiles(), "FileFlows", "FileFlows.Server.dll"),
  ];
}

function nodeDllCandidates() {
  return [
    path.join(appData(), "FileFlows", "Node", "FileFlows.Node.dll"),
    path.join(localAppData(), "FileFlows", "Node", "FileFlows.Node.dll"),
    path.join(programFiles(), "FileFlows", "Node", "FileFlows.Node.dll"),
    path.join(programFiles(), "FileFlows", "FileFlows.Node.dll"),
  ];
}

function readNodeApiPort(nodeDir) {
  if (!nodeDir) return 0;
  const envPath = path.join(nodeDir, ".env");
  try {
    if (fs.existsSync(envPath)) {
      const text = fs.readFileSync(envPath, "utf8");
      const match = text.match(/^\s*(?:FF_)?API_PORT\s*=\s*(\d+)/im);
      if (match) return Number(match[1]) || 0;
    }
  } catch {
    // ignore
  }
  return 0;
}

/**
 * @returns {Array<{
 *   id: string,
 *   role: "server" | "node",
 *   port: number,
 *   windowsService: string,
 *   exePath: string,
 *   exeArgs: string,
 *   exeCwd: string,
 * }>}
 */
export function detectFileFlowsInstalls() {
  const serverDll = firstExisting(serverDllCandidates());
  const nodeDll = firstExisting(nodeDllCandidates());
  const serverSvc = findService(["FileFlows Server", "FileFlows"]);
  const nodeSvc = findService(["FileFlows Node", "FileFlowsNode"]);

  /** @type {ReturnType<typeof detectFileFlowsInstalls>} */
  const found = [];

  if (serverDll || serverSvc) {
    const cwd = serverDll ? path.dirname(serverDll) : "";
    found.push({
      id: "fileflows",
      role: "server",
      port: SERVER_PORT,
      windowsService: serverSvc || "FileFlows",
      exePath: "",
      exeArgs: serverDll ? "FileFlows.Server.dll" : "",
      exeCwd: cwd,
    });
  }

  // Node/client - RetroArch case. Prefer a distinct service name when present.
  if (nodeDll || nodeSvc) {
    const cwd = nodeDll ? path.dirname(nodeDll) : "";
    const port = readNodeApiPort(cwd) || NODE_API_PORTS[0];
    let windowsService = nodeSvc;
    if (!windowsService) {
      // Many installs use NSSM name "FileFlows" for the node when server is elsewhere.
      if (!serverDll) windowsService = findService(["FileFlows"]) || "FileFlows";
      else windowsService = "FileFlows Node";
    }
    found.push({
      id: "fileflows-node",
      role: "node",
      port,
      windowsService,
      exePath: "",
      exeArgs: nodeDll ? "FileFlows.Node.dll" : "",
      exeCwd: cwd,
    });
  }

  return found;
}
