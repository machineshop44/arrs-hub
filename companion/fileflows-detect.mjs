/**
 * Detect FileFlows Server and/or processing Node (client) on this PC.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildFileFlowsLaunch,
  findWindowsService,
} from "../server/fileflows-launch.mjs";

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

function findService(candidates) {
  return findWindowsService(candidates);
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
    const launch = buildFileFlowsLaunch("server", cwd);
    found.push({
      id: "fileflows",
      role: "server",
      port: SERVER_PORT,
      windowsService: serverSvc || "",
      ...launch,
    });
  }

  // Node/client - RetroArch case. Prefer a distinct service name when present.
  if (nodeDll || nodeSvc) {
    const cwd = nodeDll ? path.dirname(nodeDll) : "";
    const port = readNodeApiPort(cwd) || NODE_API_PORTS[0];
    let windowsService = nodeSvc;
    if (!windowsService && !serverDll) {
      // Node-only PC: NSSM is often named FileFlows or FileFlowsNode.
      windowsService = findService(["FileFlows", "FileFlowsNode"]) || "";
    }
    const launch = buildFileFlowsLaunch("node", cwd);
    found.push({
      id: "fileflows-node",
      role: "node",
      port,
      windowsService,
      ...launch,
    });
  }

  return found;
}
