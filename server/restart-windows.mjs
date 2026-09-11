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

/** Only allow safe fragments inside PowerShell scripts (then base64-encode). */
function sanitizePsLiteral(value, max = 180) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9._\\/ :()-]/g, "")
    .slice(0, max);
}

function runPowerShell(command, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const encoded = Buffer.from(String(command || ""), "utf16le").toString(
      "base64",
    );
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
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
 * Prefer Restart-Service when running; Start-Service when stopped.
 * Hung services often look "Running" — Restart-Service is the real recovery.
 */
export function startWindowsService(serviceName) {
  return new Promise((resolve) => {
    const name = String(serviceName || "").trim();
    if (!name) {
      resolve({ ok: false, message: "No Windows service name configured" });
      return;
    }
    const safe = sanitizePsLiteral(name, 120).replace(/'/g, "");
    if (!safe) {
      resolve({ ok: false, message: "Invalid Windows service name" });
      return;
    }

    const ps = `
$ErrorActionPreference = 'Stop'
try {
  $s = Get-Service -Name '${safe}' -ErrorAction Stop
  if ($s.Status -eq 'Running') {
    Restart-Service -Name '${safe}' -Force -ErrorAction Stop
    Write-Output 'RESTARTED'
  } else {
    Start-Service -Name '${safe}' -ErrorAction Stop
    Write-Output 'STARTED'
  }
} catch {
  Write-Output ('FAIL=' + $_.Exception.Message)
}
`;
    runPowerShell(ps, 45000).then((result) => {
      const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
      if (/RESTARTED|STARTED/.test(output) && !/^FAIL=/.test(output)) {
        const action = /RESTARTED/.test(output) ? "Restarted" : "Started";
        resolve({
          ok: true,
          message: `${action} Windows service "${name}"`,
        });
      } else {
        resolve({
          ok: false,
          message:
            output.replace(/^FAIL=/, "").trim() ||
            `Could not restart service "${name}"`,
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

/**
 * Kill hung processes matching role/hints before launching a fresh exe.
 */
async function killMatchingProcesses(serviceCfg, launch) {
  const role =
    fileFlowsRoleFromPath(
      `${launch.exePath || ""} ${launch.exeArgs || ""} ${launch.exeCwd || ""}`,
    ) ||
    (String(serviceCfg?.id || "").includes("node") ? "node" : "") ||
    (String(serviceCfg?.windowsService || "").toLowerCase().includes("node")
      ? "node"
      : "");

  const names = [];
  if (role === "node") {
    names.push("FileFlows.Node");
  } else if (role === "server") {
    names.push("FileFlows.Server");
  }

  const exeBase = launch.exePath
    ? path.basename(launch.exePath).replace(/\.exe$/i, "")
    : "";
  if (exeBase && !/^dotnet$/i.test(exeBase)) {
    names.push(sanitizePsLiteral(exeBase, 80));
  }

  const unique = [...new Set(names.filter(Boolean))];
  if (unique.length === 0) {
    return { ok: true, message: "No process kill targets" };
  }

  const nameList = unique.map((n) => `'${sanitizePsLiteral(n, 80)}'`).join(",");
  const hintBlob = sanitizePsLiteral(
    [
      launch.exePath,
      launch.exeArgs,
      launch.exeCwd,
      ...(Array.isArray(serviceCfg.processHints) ? serviceCfg.processHints : []),
    ]
      .map((x) => String(x || "").toLowerCase())
      .join(" "),
    400,
  );

  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$names = @(${nameList})
$killed = 0
foreach ($n in $names) {
  Get-Process -Name $n -ErrorAction SilentlyContinue | ForEach-Object {
    try { Stop-Process -Id $_.Id -Force -ErrorAction Stop; $killed++ } catch {}
  }
}
# Hung FileFlows often sits in dotnet — match command line for role only.
$hint = '${hintBlob}'.ToLowerInvariant()
if ($hint -match 'fileflows\\.node' -or $hint -match '\\\\node') {
  Get-CimInstance Win32_Process -Filter "Name='dotnet.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
    $cmd = ([string]$_.CommandLine).ToLowerInvariant()
    if ($cmd.Contains('fileflows.node') -and -not $cmd.Contains('fileflows.server')) {
      try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; $killed++ } catch {}
    }
  }
} elseif ($hint -match 'fileflows\\.server' -or $hint -match '\\\\server') {
  Get-CimInstance Win32_Process -Filter "Name='dotnet.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
    $cmd = ([string]$_.CommandLine).ToLowerInvariant()
    if ($cmd.Contains('fileflows.server') -and -not $cmd.Contains('fileflows.node')) {
      try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; $killed++ } catch {}
    }
  }
}
Write-Output ("KILLED=" + $killed)
`;
  const result = await runPowerShell(ps, 15000);
  const out = `${result.stdout || ""}`.trim();
  const match = out.match(/KILLED=(\d+)/i);
  const count = match ? Number(match[1]) : 0;
  return {
    ok: true,
    message: count > 0 ? `Stopped ${count} process(es)` : "No matching process to stop",
  };
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
 * Prefer Windows service restart; if that fails or no service name, kill then start exe.
 * @param {{ windowsService?: string, exePath?: string, exeArgs?: string, exeCwd?: string, id?: string, processHints?: string[] }} serviceCfg
 */
export async function restartServiceOrExe(serviceCfg) {
  const launch = normalizeLaunchConfig(serviceCfg);
  const serviceName = String(serviceCfg.windowsService || "").trim();
  const exePath = String(launch.exePath || "").trim();

  if (serviceName && windowsServiceExists(serviceName)) {
    const serviceResult = await startWindowsService(serviceName);
    if (serviceResult.ok) return serviceResult;
    if (exePath) {
      const kill = await killMatchingProcesses(serviceCfg, launch);
      const exeResult = await startExeProcess(
        launch.exePath,
        launch.exeArgs,
        launch.exeCwd,
      );
      return {
        ok: exeResult.ok,
        message: `${serviceResult.message}; ${kill.message}; exe fallback: ${exeResult.message}`,
      };
    }
    return serviceResult;
  }

  if (exePath) {
    const kill = await killMatchingProcesses(serviceCfg, launch);
    const exeResult = await startExeProcess(
      launch.exePath,
      launch.exeArgs,
      launch.exeCwd,
    );
    return {
      ok: exeResult.ok,
      message: `${kill.message}; ${exeResult.message}`,
    };
  }

  return {
    ok: false,
    message: "No Windows service name or exe path configured",
  };
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
 *   id?: string,
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
  const role =
    fileFlowsRoleFromPath(`${exePath} ${exeArgs} ${exeCwd}`) ||
    (String(serviceCfg.id || "").includes("node")
      ? "node"
      : String(serviceCfg.id || "") === "fileflows"
        ? "server"
        : "");

  const hints = Array.isArray(serviceCfg.processHints)
    ? serviceCfg.processHints.map((h) => String(h || "").trim()).filter(Boolean)
    : [];

  if (exeArgs) hints.push(exeArgs);
  if (exeCwd) hints.push(path.basename(exeCwd));
  if (exePath) {
    hints.push(path.basename(exePath));
  }

  // Role-strict FileFlows hints — Node must never match Server and vice versa.
  if (role === "node") {
    hints.push("FileFlows.Node", "fileflows.node.dll");
  } else if (role === "server") {
    hints.push("FileFlows.Server", "fileflows.server.dll");
  } else if (/fileflows/i.test(`${exePath}${exeArgs}${exeCwd}`)) {
    // Ambiguous path: prefer Node folder naming only when present
    if (/node/i.test(`${exePath}${exeCwd}`)) {
      hints.push("FileFlows.Node", "fileflows.node.dll");
    } else if (/server/i.test(`${exePath}${exeCwd}`)) {
      hints.push("FileFlows.Server", "fileflows.server.dll");
    }
  }

  if (serviceName && windowsServiceExists(serviceName)) {
    const safe = sanitizePsLiteral(serviceName, 120).replace(/'/g, "");
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
  }

  const uniqueHints = [
    ...new Set(
      hints
        .map((h) => sanitizePsLiteral(h.toLowerCase(), 120))
        .filter(Boolean),
    ),
  ].slice(0, 8);

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

  const processNames = new Set(["dotnet.exe"]);
  if (role === "node") {
    processNames.add("fileflows.node.exe");
  } else if (role === "server") {
    processNames.add("fileflows.server.exe");
  } else {
    processNames.add("fileflows.node.exe");
    processNames.add("fileflows.server.exe");
    processNames.add("fileflows.exe");
  }
  const exeBase = exePath ? path.basename(exePath).toLowerCase() : "";
  if (exeBase.endsWith(".exe")) processNames.add(exeBase);

  const nameFilter = [...processNames]
    .map((n) => `Name='${sanitizePsLiteral(n, 80)}'`)
    .join(" OR ");

  const hintList = uniqueHints.map((h) => `'${h}'`).join(",");
  const namedProbe =
    role === "node"
      ? "Get-Process -Name 'FileFlows.Node' -ErrorAction SilentlyContinue"
      : role === "server"
        ? "Get-Process -Name 'FileFlows.Server' -ErrorAction SilentlyContinue"
        : "Get-Process -Name 'FileFlows.Node','FileFlows.Server','FileFlows' -ErrorAction SilentlyContinue";

  const forbidServer = role === "node";
  const forbidNode = role === "server";

  const psProc = `
$hints = @(${hintList})
try {
  $named = ${namedProbe} | Select-Object -First 1
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
  ${forbidServer ? "if ($blob.Contains('fileflows.server')) { continue }" : ""}
  ${forbidNode ? "if ($blob.Contains('fileflows.node')) { continue }" : ""}
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
