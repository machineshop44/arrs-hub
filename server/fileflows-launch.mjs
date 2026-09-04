/**
 * Shared FileFlows launch + Windows service helpers (Hub server + Companion).
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function firstExisting(paths) {
  for (const p of paths) {
    if (p && fs.existsSync(p)) return p;
  }
  return "";
}

function programFiles() {
  return process.env["ProgramFiles"] || "C:\\Program Files";
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

function dotnetExe() {
  return firstExisting([
    path.join(programFiles(), "dotnet", "dotnet.exe"),
    path.join(
      process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
      "dotnet",
      "dotnet.exe",
    ),
  ]);
}

/** @param {string[]} candidates */
export function findWindowsService(candidates) {
  for (const name of candidates) {
    const hit = queryWindowsService(name);
    if (hit) return hit.name;
  }
  return "";
}

export function windowsServiceExists(serviceName) {
  return Boolean(queryWindowsService(String(serviceName || "").trim()));
}

/**
 * FileFlows NSSM installs use dotnet.exe + *.dll from the install folder.
 * @param {"server"|"node"} role
 * @param {string} installDir
 */
export function buildFileFlowsLaunch(role, installDir) {
  const dir = String(installDir || "").trim();
  if (!dir) {
    return { exePath: "", exeArgs: "", exeCwd: "" };
  }
  const dll =
    role === "node" ? "FileFlows.Node.dll" : "FileFlows.Server.dll";
  const apphost =
    role === "node" ? "FileFlows.Node.exe" : "FileFlows.Server.exe";
  const dotnet = dotnetExe();
  const dllPath = path.join(dir, dll);
  const apphostPath = path.join(dir, apphost);

  if (dotnet && fs.existsSync(dllPath)) {
    return { exePath: dotnet, exeArgs: dll, exeCwd: dir };
  }
  if (fs.existsSync(apphostPath)) {
    return { exePath: apphostPath, exeArgs: "", exeCwd: dir };
  }
  return { exePath: "", exeArgs: "", exeCwd: dir };
}
