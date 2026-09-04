import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  buildFileFlowsLaunch,
  windowsServiceExists,
} from "./fileflows-launch.mjs";

function splitExeArgs(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];
  const matches = text.match(/(?:[^\s"]+|"[^"]*")+/g);
  if (!matches) return [];
  return matches.map((part) =>
    part.startsWith('"') && part.endsWith('"') ? part.slice(1, -1) : part,
  );
}

export function startWindowsService(serviceName) {
  return new Promise((resolve) => {
    if (!serviceName?.trim()) {
      resolve({ ok: false, message: "No Windows service name configured" });
      return;
    }

    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `try { Start-Service -Name '${serviceName.replace(/'/g, "''")}' -ErrorAction Stop; 'STARTED' } catch { $_.Exception.Message }`,
      ],
      { windowsHide: true },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      const output = (stdout || stderr).trim();
      if (code === 0 && output.includes("STARTED")) {
        resolve({
          ok: true,
          message: `Started Windows service "${serviceName}"`,
        });
      } else {
        resolve({
          ok: false,
          message: output || `Could not start service "${serviceName}"`,
        });
      }
    });
  });
}

function fileFlowsRoleFromPath(text) {
  const lower = String(text || "").toLowerCase();
  if (lower.includes("fileflows.node")) return "node";
  if (lower.includes("fileflows.server")) return "server";
  if (lower.includes("\\node")) return "node";
  if (lower.includes("\\server")) return "server";
  return "";
}

/** Normalize FileFlows / directory exe paths before restart or status checks. */
export function normalizeLaunchConfig(serviceCfg) {
  let exePath = String(serviceCfg.exePath || "").trim();
  let exeArgs = String(serviceCfg.exeArgs || "").trim();
  let exeCwd = String(serviceCfg.exeCwd || "").trim();

  if (exePath && fs.existsSync(exePath)) {
    try {
      if (fs.statSync(exePath).isDirectory()) {
        const role = fileFlowsRoleFromPath(exePath) || "node";
        const launch = buildFileFlowsLaunch(role, exePath);
        if (launch.exePath) return launch;
      }
    } catch {
      // ignore
    }
  }

  if (
    /FileFlows\.(Node|Server)\.exe$/i.test(exePath) &&
    /FileFlows\.(Node|Server)\.dll$/i.test(exeArgs)
  ) {
    const role = /Node/i.test(exePath) ? "node" : "server";
    const launch = buildFileFlowsLaunch(role, exeCwd || path.dirname(exePath));
    if (launch.exePath) return launch;
    return { exePath, exeArgs: "", exeCwd: exeCwd || path.dirname(exePath) };
  }

  if (/FileFlows\.(Node|Server)\.exe$/i.test(exePath)) {
    const role = /Node/i.test(exePath) ? "node" : "server";
    const launch = buildFileFlowsLaunch(role, exeCwd || path.dirname(exePath));
    if (launch.exePath) return launch;
    return { exePath, exeArgs: "", exeCwd: exeCwd || path.dirname(exePath) };
  }

  if (
    !exePath &&
    /FileFlows\.(Node|Server)\.dll$/i.test(exeArgs) &&
    exeCwd
  ) {
    const role = /Node/i.test(exeArgs) ? "node" : "server";
    return buildFileFlowsLaunch(role, exeCwd);
  }

  if (exePath && !exeCwd) {
    exeCwd = path.dirname(exePath);
  }

  return { exePath, exeArgs, exeCwd };
}

export function startExeProcess(exePath, exeArgs, exeCwd) {
  return new Promise((resolve) => {
    const file = String(exePath || "").trim();
    if (!file) {
      resolve({ ok: false, message: "No exe path configured" });
      return;
    }

    const args = splitExeArgs(exeArgs);
    const cwd = String(exeCwd || "").trim() || path.dirname(file);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    try {
      const child = spawn(file, args, {
        cwd,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        shell: false,
      });
      child.on("error", (err) => {
        finish({
          ok: false,
          message: err?.message || `Could not start exe "${file}"`,
        });
      });
      child.unref();
      setTimeout(() => {
        finish({
          ok: true,
          message: `Started exe "${file}"${args.length ? ` ${args.join(" ")}` : ""}`,
        });
      }, 250);
    } catch (err) {
      finish({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

/**
 * Prefer Windows service; if that fails or no service name, try optional exe.
 * @param {{ windowsService?: string, exePath?: string, exeArgs?: string, exeCwd?: string }} serviceCfg
 */
export async function restartServiceOrExe(serviceCfg) {
  const launch = normalizeLaunchConfig(serviceCfg);
  const serviceName = String(serviceCfg.windowsService || "").trim();
  const exePath = String(launch.exePath || "").trim();

  if (serviceName && windowsServiceExists(serviceName)) {
    const serviceResult = await startWindowsService(serviceName);
    if (serviceResult.ok) return serviceResult;
    if (exePath) {
      const exeResult = await startExeProcess(
        launch.exePath,
        launch.exeArgs,
        launch.exeCwd,
      );
      return {
        ok: exeResult.ok,
        message: `${serviceResult.message}; exe fallback: ${exeResult.message}`,
      };
    }
    return serviceResult;
  }

  if (exePath) {
    return startExeProcess(launch.exePath, launch.exeArgs, launch.exeCwd);
  }

  return {
    ok: false,
    message: "No Windows service name or exe path configured",
  };
}

function runPowerShell(command, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      resolve({ code: -1, stdout, stderr: stderr || "timeout" });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/**
 * Check whether a Windows service and/or related process is running locally.
 * Used by Companion so Hub can show FileFlows Node (etc.) status without a TCP port.
 *
 * @param {{
 *   windowsService?: string,
 *   exePath?: string,
 *   exeArgs?: string,
 *   exeCwd?: string,
 *   processHints?: string[],
 * }} serviceCfg
 * @returns {Promise<{
 *   ok: boolean,
 *   running: boolean,
 *   method: string|null,
 *   message: string,
 *   latencyMs: number|null,
 *   serviceState?: string|null,
 * }>}
 */
export async function checkLocalServiceStatus(serviceCfg) {
  const started = Date.now();
  const launch = normalizeLaunchConfig(serviceCfg);
  const serviceName = String(serviceCfg.windowsService || "").trim();
  const exePath = String(launch.exePath || "").trim();
  const exeArgs = String(launch.exeArgs || "").trim();
  const exeCwd = String(launch.exeCwd || "").trim();
  const hints = Array.isArray(serviceCfg.processHints)
    ? serviceCfg.processHints.map((h) => String(h || "").trim()).filter(Boolean)
    : [];

  if (exeArgs) hints.push(exeArgs);
  if (exeCwd) hints.push(path.basename(exeCwd));
  if (exePath) {
    hints.push(path.basename(exePath));
    if (/fileflows\.(node|server)/i.test(exePath + exeArgs + exeCwd)) {
      hints.push("FileFlows.Node", "FileFlows.Server", "fileflows.node.dll");
    }
    // Directory installs (FileFlows Node folder) - match common process names
    if (!path.extname(exePath)) {
      hints.push("FileFlows.Node", "FileFlows.Server", "fileflows.node.dll");
    }
  }

  if (serviceName && windowsServiceExists(serviceName)) {
    const safe = serviceName.replace(/'/g, "''");
    const ps = `
$ErrorActionPreference = 'Stop'
try {
  $s = Get-Service -Name '${safe}' -ErrorAction Stop
  Write-Output ("STATE=" + $s.Status)
} catch {
  Write-Output ("MISSING=" + $_.Exception.Message)
}
`;
    const result = await runPowerShell(ps);
    const out = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
    const latencyMs = Date.now() - started;
    const stateMatch = out.match(/STATE=(\w+)/i);
    if (stateMatch) {
      const serviceState = stateMatch[1];
      const running = /^running$/i.test(serviceState);
      if (running) {
        return {
          ok: true,
          running: true,
          method: "windows-service",
          serviceState,
          latencyMs,
          message: `Service "${serviceName}" is Running`,
        };
      }
      // Service exists but stopped/paused — still check process (dotnet FileFlows.Node
      // often runs without the Windows service being Running).
      if (hints.length === 0) {
        return {
          ok: true,
          running: false,
          method: "windows-service",
          serviceState,
          latencyMs,
          message: `Service "${serviceName}" is ${serviceState}`,
        };
      }
    } else if (hints.length === 0) {
      return {
        ok: true,
        running: false,
        method: "windows-service",
        serviceState: null,
        latencyMs,
        message: `Service "${serviceName}" not found`,
      };
    }
    // Service missing or not running — fall through to process check.
  }

  const uniqueHints = [...new Set(hints.map((h) => h.toLowerCase()))].slice(
    0,
    8,
  );
  if (uniqueHints.length === 0) {
    return {
      ok: false,
      running: false,
      method: null,
      serviceState: null,
      latencyMs: Date.now() - started,
      message: "No Windows service name or process hints configured",
    };
  }

  const exeBase = exePath ? path.basename(exePath).toLowerCase() : "";
  const processNames = new Set([
    "dotnet.exe",
    "fileflows.node.exe",
    "fileflows.server.exe",
    "fileflows.exe",
  ]);
  if (exeBase.endsWith(".exe")) processNames.add(exeBase);
  const nameFilter = [...processNames]
    .map((n) => `Name='${n.replace(/'/g, "''")}'`)
    .join(" OR ");

  const hintList = uniqueHints
    .map((h) => `'${h.replace(/'/g, "''")}'`)
    .join(",");
  const psProc = `
$hints = @(${hintList})
try {
  $named = Get-Process -Name 'FileFlows.Node','FileFlows.Server','FileFlows' -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($named) {
    Write-Output ("RUNNING=" + $named.ProcessName + ".exe pid=" + $named.Id)
    exit 0
  }
  $procs = Get-CimInstance Win32_Process -Filter "${nameFilter}" -ErrorAction Stop
} catch {
  Write-Output ('UNKNOWN=' + $_.Exception.Message)
  exit 0
}
$hit = $false
$detail = ''
foreach ($p in $procs) {
  $blob = (($p.Name + ' ' + $p.CommandLine) + '').ToLowerInvariant()
  foreach ($h in $hints) {
    if ($h -eq 'dotnet.exe') { continue }
    if ($blob.Contains($h)) {
      $hit = $true
      $cmd = [string]$p.CommandLine
      if ($cmd.Length -gt 80) { $cmd = $cmd.Substring(0, 80) }
      $detail = $p.Name + ' pid=' + $p.ProcessId + ' ' + $cmd
      break
    }
  }
  if ($hit) { break }
}
if ($hit) { Write-Output ("RUNNING=" + $detail) } else { Write-Output 'STOPPED' }
`;
  const procResult = await runPowerShell(psProc, 8000);
  const out = `${procResult.stdout || ""}`.trim();
  const latencyMs = Date.now() - started;
  const timedOut = procResult.code === -1;
  if (timedOut || !out || out.startsWith("UNKNOWN=")) {
    return {
      ok: false,
      running: false,
      method: "process",
      serviceState: null,
      latencyMs,
      message: timedOut
        ? "Process check timed out (status unknown)"
        : out.replace(/^UNKNOWN=/, "") || "Process check failed (unknown)",
    };
  }
  if (out.startsWith("RUNNING=")) {
    const detail = out.slice("RUNNING=".length);
    return {
      ok: true,
      running: true,
      method: "process",
      serviceState: null,
      latencyMs,
      message: `Process running (${detail})`,
    };
  }
  return {
    ok: true,
    running: false,
    method: "process",
    serviceState: null,
    latencyMs,
    message: "No matching process running",
  };
}

