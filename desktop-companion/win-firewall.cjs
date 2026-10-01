/**
 * Windows Firewall check/fix so Arrs Hub (Plex PC) can reach Companion's API port.
 * Registration is outbound and works without this; status checks are inbound and don't.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function ruleName(port) {
  return `Arrs Hub Companion (TCP ${port})`;
}

function psLiteral(value) {
  return String(value || "").replace(/'/g, "''");
}

function runPowerShell(script, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
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
      resolve({ code: 1, stdout: "", stderr: err?.message || String(err) });
    });
  });
}

/** Block rules that would stop inbound traffic to Companion (by name or by its exe). */
function blockRulesSnippet(exePath) {
  return `
$exe = '${psLiteral(exePath)}'
$blocks = @(Get-NetFirewallRule -Direction Inbound -Action Block -ErrorAction SilentlyContinue | Where-Object {
  if ($_.DisplayName -match '(?i)arrs hub companion') { return $true }
  if (-not $exe) { return $false }
  $prog = ($_ | Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue).Program
  return ($prog -and ($prog -ieq $exe))
})
`;
}

/**
 * @returns {Promise<{ ok: boolean, needsFix: boolean, blockCount: number, allowRule: boolean, message: string }>}
 */
async function checkCompanionFirewall(port, exePath) {
  if (process.platform !== "win32") {
    return { ok: true, needsFix: false, blockCount: 0, allowRule: true, message: "Not Windows" };
  }
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
${blockRulesSnippet(exePath)}
$allow = @(Get-NetFirewallRule -DisplayName '${psLiteral(ruleName(port))}' -ErrorAction SilentlyContinue |
  Where-Object { $_.Enabled -eq 'True' -and $_.Action -eq 'Allow' -and $_.Profile -eq 'Any' })
Write-Output ("BLOCK=" + $blocks.Count)
Write-Output ("ALLOW=" + $allow.Count)
`;
  const result = await runPowerShell(script);
  const block = /BLOCK=(\d+)/.exec(result.stdout);
  const allow = /ALLOW=(\d+)/.exec(result.stdout);
  if (!block || !allow) {
    return {
      ok: false,
      needsFix: false,
      blockCount: 0,
      allowRule: false,
      message: (result.stderr || "Firewall check failed").trim(),
    };
  }
  const blockCount = Number(block[1]);
  const allowRule = Number(allow[1]) > 0;
  return {
    ok: true,
    needsFix: blockCount > 0 || !allowRule,
    blockCount,
    allowRule,
    message:
      blockCount > 0
        ? `${blockCount} firewall rule(s) block Companion`
        : allowRule
          ? `Port ${port} allowed on all networks`
          : `No firewall rule allows port ${port} on all networks`,
  };
}

/**
 * Elevated (one UAC prompt): remove Companion block rules, allow the API port on all profiles.
 * @returns {Promise<{ ok: boolean, cancelled?: boolean, message: string }>}
 */
async function fixCompanionFirewall(port, exePath) {
  if (process.platform !== "win32") return { ok: false, message: "Not Windows" };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arrs-companion-fw-"));
  const scriptPath = path.join(dir, "fix-firewall.ps1");
  const resultPath = path.join(dir, "result.txt");
  const name = psLiteral(ruleName(port));
  fs.writeFileSync(
    scriptPath,
    `
$ErrorActionPreference = 'Stop'
try {
${blockRulesSnippet(exePath)}
  $removed = $blocks.Count
  if ($removed -gt 0) { $blocks | Remove-NetFirewallRule }
  Get-NetFirewallRule -DisplayName '${name}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName '${name}' -Direction Inbound -Protocol TCP -LocalPort ${Number(port)} -Action Allow -Profile Any | Out-Null
  Set-Content -LiteralPath '${psLiteral(resultPath)}' -Value ("OK REMOVED=" + $removed)
} catch {
  Set-Content -LiteralPath '${psLiteral(resultPath)}' -Value ("FAIL " + $_.Exception.Message)
}
`,
    "utf8",
  );

  const launcher = `
try {
  Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','"${psLiteral(scriptPath)}"')
  Write-Output 'LAUNCHED'
} catch {
  Write-Output ('CANCELLED ' + $_.Exception.Message)
}
`;
  try {
    const launched = await runPowerShell(launcher, 120000);
    if (/CANCELLED/.test(launched.stdout)) {
      return { ok: false, cancelled: true, message: "Administrator prompt was cancelled." };
    }
    const out = fs.existsSync(resultPath) ? fs.readFileSync(resultPath, "utf8").trim() : "";
    if (out.startsWith("OK")) {
      const removed = Number(/REMOVED=(\d+)/.exec(out)?.[1] || 0);
      return {
        ok: true,
        message:
          `Port ${port} is now allowed on all networks.` +
          (removed > 0 ? ` Removed ${removed} blocking rule(s).` : ""),
      };
    }
    return { ok: false, message: out.replace(/^FAIL\s*/, "") || "Firewall update did not finish." };
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

module.exports = { checkCompanionFirewall, fixCompanionFirewall, ruleName };
