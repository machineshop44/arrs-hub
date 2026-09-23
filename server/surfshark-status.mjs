/**
 * Surfshark process + VPN tunnel status (Windows).
 * Used by Companion (download PC) and Hub local probes.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function runPowerShell(command, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const encoded = Buffer.from(String(command || ""), "utf16le").toString(
      "base64",
    );
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encoded,
      ],
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
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        code: 1,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
      });
    });
  });
}

function userProfile() {
  return process.env.USERPROFILE || os.homedir();
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

function programFilesX86() {
  return process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
}

export function surfsharkExeCandidates() {
  return [
    path.join(programFiles(), "Surfshark", "Surfshark.exe"),
    path.join(programFilesX86(), "Surfshark", "Surfshark.exe"),
    path.join(localAppData(), "Programs", "Surfshark", "Surfshark.exe"),
    path.join(localAppData(), "Surfshark", "Surfshark.exe"),
  ];
}

export function findSurfsharkExe() {
  for (const candidate of surfsharkExeCandidates()) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return "";
}

/**
 * @returns {Promise<{
 *   ok: boolean,
 *   installed: boolean,
 *   processRunning: boolean,
 *   vpnConnected: boolean,
 *   running: boolean,
 *   method: string|null,
 *   adapterName: string|null,
 *   exePath: string|null,
 *   message: string,
 *   latencyMs: number|null,
 * }>}
 */
export async function getSurfsharkStatus() {
  const started = Date.now();
  const exePath = findSurfsharkExe();
  const installed = Boolean(exePath);

  if (process.platform !== "win32") {
    return {
      ok: true,
      installed,
      processRunning: false,
      vpnConnected: false,
      running: false,
      method: null,
      adapterName: null,
      exePath: exePath || null,
      message: "Surfshark status is only available on Windows",
      latencyMs: Date.now() - started,
    };
  }

  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$proc = $false
try {
  $names = Get-Process | Where-Object {
    $_.ProcessName -match '(?i)surfshark'
  }
  if ($names) { $proc = $true }
} catch {}

$vpn = $false
$adapter = ''
try {
  $candidates = Get-NetAdapter | Where-Object {
    $_.Status -eq 'Up' -and (
      $_.Name -match '(?i)surfshark|sshark' -or
      $_.InterfaceDescription -match '(?i)surfshark|sshark'
    )
  }
  foreach ($a in $candidates) {
    $ips = Get-NetIPAddress -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object { $_.IPAddress -and $_.IPAddress -notlike '169.254.*' }
    if ($ips) {
      $vpn = $true
      $adapter = [string]$a.Name
      break
    }
  }
  if (-not $vpn) {
    # Surfshark often uses a Wintun/WireGuard adapter without "Surfshark" in the name
    # while the client is connected — only trust this when the app process is up.
    if ($proc) {
      $wg = Get-NetAdapter | Where-Object {
        $_.Status -eq 'Up' -and (
          $_.InterfaceDescription -match '(?i)wintun|wireguard|surfshark' -or
          $_.Name -match '(?i)wireguard|wintun|surfshark|sshark'
        )
      }
      foreach ($a in $wg) {
        $ips = Get-NetIPAddress -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
          Where-Object { $_.IPAddress -and $_.IPAddress -notlike '169.254.*' }
        if ($ips) {
          $vpn = $true
          $adapter = [string]$a.Name
          break
        }
      }
    }
  }
} catch {}

Write-Output ("PROC=" + ($(if ($proc) {'1'} else {'0'})))
Write-Output ("VPN=" + ($(if ($vpn) {'1'} else {'0'})))
Write-Output ("ADAPTER=" + $adapter)
`;

  try {
    const result = await runPowerShell(ps);
    const out = `${result.stdout || ""}\n${result.stderr || ""}`;
    const processRunning = /PROC=1/i.test(out);
    const vpnConnected = /VPN=1/i.test(out);
    const adapterMatch = out.match(/ADAPTER=(.+)/i);
    const adapterName = adapterMatch
      ? String(adapterMatch[1] || "").trim() || null
      : null;

    const running = processRunning && vpnConnected;
    let message;
    if (running) {
      message = adapterName
        ? `Surfshark VPN connected (${adapterName})`
        : "Surfshark VPN connected";
    } else if (processRunning && !vpnConnected) {
      message = "Surfshark running · VPN disconnected";
    } else if (!processRunning && vpnConnected) {
      message = adapterName
        ? `VPN adapter up (${adapterName}) but Surfshark app not running`
        : "VPN adapter up but Surfshark app not running";
    } else if (!installed) {
      message = "Surfshark not installed";
    } else {
      message = "Surfshark not running";
    }

    return {
      ok: true,
      installed,
      processRunning,
      vpnConnected,
      running,
      method: running
        ? "surfshark-vpn"
        : processRunning
          ? "surfshark-process"
          : null,
      adapterName,
      exePath: exePath || null,
      message,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      installed,
      processRunning: false,
      vpnConnected: false,
      running: false,
      method: null,
      adapterName: null,
      exePath: exePath || null,
      message: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - started,
    };
  }
}
