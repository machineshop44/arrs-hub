/**
 * StableBit DrivePool + Scanner status on the Hub PC (Windows).
 * DrivePool: service state + pooled volume free space (Covecube virtual disk).
 * Scanner: service state + Windows physical-disk health / SMART predict-failure.
 * Neither product exposes a local API, so disk health comes from Windows storage
 * WMI — the same SMART data Scanner reads, not Scanner's own verdicts.
 */
import { spawn } from "node:child_process";

const CACHE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 20_000;
const LOW_FREE_PCT = 10;

let cache = null;
let cacheAt = 0;
let inflight = null;

function runPowerShell(command, timeoutMs = PROBE_TIMEOUT_MS) {
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

const PROBE_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'

function SvcInfo($svc) {
  if (-not $svc) { return $null }
  return @{ name = [string]$svc.Name; displayName = [string]$svc.DisplayName; status = [string]$svc.Status }
}

$dpSvc = Get-Service | Where-Object {
  $_.Name -eq 'DrivePoolService' -or $_.DisplayName -match '(?i)stablebit drivepool'
} | Select-Object -First 1
$scSvc = Get-Service | Where-Object {
  $_.Name -eq 'Scanner' -or $_.DisplayName -match '(?i)stablebit scanner'
} | Select-Object -First 1

$pools = @()
if ($dpSvc) {
  Get-CimInstance Win32_DiskDrive | Where-Object { $_.Model -match '(?i)covecube' } | ForEach-Object {
    Get-CimAssociatedInstance -InputObject $_ -ResultClassName Win32_DiskPartition | ForEach-Object {
      Get-CimAssociatedInstance -InputObject $_ -ResultClassName Win32_LogicalDisk | ForEach-Object {
        $pools += @{
          letter = [string]$_.DeviceID
          label = [string]$_.VolumeName
          size = [int64]$_.Size
          free = [int64]$_.FreeSpace
        }
      }
    }
  }
}

$disks = @()
$smartFailures = 0
if ($scSvc) {
  $healthNames = @{ 0 = 'Healthy'; 1 = 'Warning'; 2 = 'Unhealthy'; 5 = 'Unknown' }
  Get-CimInstance -Namespace root\\Microsoft\\Windows\\Storage -ClassName MSFT_PhysicalDisk |
    Where-Object { $_.FriendlyName -notmatch '(?i)covecube' } | ForEach-Object {
      $h = [int]$_.HealthStatus
      $name = $healthNames[$h]
      if (-not $name) { $name = 'Unknown' }
      $disks += @{
        name = [string]$_.FriendlyName
        size = [int64]$_.Size
        health = $name
      }
    }
  Get-CimInstance -Namespace root\\wmi -ClassName MSStorageDriver_FailurePredictStatus | ForEach-Object {
    if ($_.PredictFailure) { $smartFailures++ }
  }
}

@{
  drivepool = @{ service = (SvcInfo $dpSvc); pools = @($pools) }
  scanner = @{ service = (SvcInfo $scSvc); disks = @($disks); smartFailures = $smartFailures }
} | ConvertTo-Json -Depth 5 -Compress
`;

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

/** Turn raw probe JSON into chip-ready DrivePool status. */
export function summarizeDrivePool(raw) {
  const service = raw?.service || null;
  if (!service) {
    return { installed: false, running: false, pools: [], message: "Not installed" };
  }
  const running = String(service.status).toLowerCase() === "running";
  const pools = asArray(raw.pools)
    .map((p) => {
      const size = Number(p?.size) || 0;
      const free = Number(p?.free) || 0;
      return {
        letter: String(p?.letter || ""),
        label: String(p?.label || ""),
        size,
        free,
        freePct: size > 0 ? Math.round((free / size) * 100) : null,
      };
    })
    .filter((p) => p.letter);
  const lowPools = pools.filter(
    (p) => p.freePct != null && p.freePct < LOW_FREE_PCT,
  );
  let message;
  if (!running) message = `DrivePool service ${service.status || "stopped"}`;
  else if (!pools.length) message = "Service running · no pool volume found";
  else if (lowPools.length) {
    message = `Low space on ${lowPools.map((p) => p.letter).join(", ")}`;
  } else message = "Pool healthy";
  return {
    installed: true,
    running,
    serviceStatus: String(service.status || ""),
    pools,
    lowSpace: lowPools.length > 0,
    message,
  };
}

/** Turn raw probe JSON into chip-ready Scanner status. */
export function summarizeScanner(raw) {
  const service = raw?.service || null;
  if (!service) {
    return { installed: false, running: false, disks: [], message: "Not installed" };
  }
  const running = String(service.status).toLowerCase() === "running";
  const disks = asArray(raw.disks).map((d) => ({
    name: String(d?.name || "Disk"),
    size: Number(d?.size) || 0,
    health: String(d?.health || "Unknown"),
  }));
  const smartFailures = Number(raw.smartFailures) || 0;
  const problemDisks = disks.filter(
    (d) => d.health === "Warning" || d.health === "Unhealthy",
  );
  const problemCount = Math.max(problemDisks.length, smartFailures);
  let message;
  if (!running) message = `Scanner service ${service.status || "stopped"}`;
  else if (problemCount > 0) {
    message = `${problemCount} disk${problemCount === 1 ? "" : "s"} reporting problems`;
  } else message = `${disks.length} disk${disks.length === 1 ? "" : "s"} healthy`;
  return {
    installed: true,
    running,
    serviceStatus: String(service.status || ""),
    disks,
    smartFailures,
    problemCount,
    message,
  };
}

async function probe() {
  if (process.platform !== "win32") {
    return {
      ok: true,
      checkedAt: new Date().toISOString(),
      drivepool: summarizeDrivePool(null),
      scanner: summarizeScanner(null),
    };
  }
  const result = await runPowerShell(PROBE_SCRIPT);
  const text = String(result.stdout || "").trim();
  const start = text.indexOf("{");
  if (start < 0) {
    throw new Error(
      String(result.stderr || "").trim().slice(0, 200) ||
        "StableBit probe returned no data",
    );
  }
  const raw = JSON.parse(text.slice(start));
  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    drivepool: summarizeDrivePool(raw.drivepool),
    scanner: summarizeScanner(raw.scanner),
  };
}

function refresh() {
  if (!inflight) {
    inflight = probe()
      .then((value) => {
        cache = value;
        cacheAt = Date.now();
        return value;
      })
      .catch((err) => {
        cache = {
          ok: false,
          checkedAt: new Date().toISOString(),
          error: err instanceof Error ? err.message : String(err),
          drivepool: cache?.drivepool ?? null,
          scanner: cache?.scanner ?? null,
        };
        cacheAt = Date.now();
        return cache;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/**
 * Stale-while-revalidate so the 20s dashboard summary never waits on
 * PowerShell/WMI. First call returns { checking: true } while probing.
 */
export function getStableBitStatus() {
  if (!cache || Date.now() - cacheAt > CACHE_TTL_MS) {
    void refresh();
  }
  return cache ?? { ok: true, checking: true, drivepool: null, scanner: null };
}
