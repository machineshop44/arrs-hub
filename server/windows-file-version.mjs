/**
 * Read Windows ProductVersion / FileVersion from an exe or DLL.
 * Shared by Hub and Companion.
 */
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function firstExistingPath(paths) {
  for (const p of paths) {
    if (p && fs.existsSync(p)) return p;
  }
  return "";
}

/**
 * @param {string} filePath
 * @returns {Promise<string|null>}
 */
export async function readWindowsFileVersion(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const script = [
      "$ErrorActionPreference='Stop'",
      `$p = ${JSON.stringify(filePath)}`,
      "$v = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($p)",
      "$out = $v.ProductVersion",
      "if (-not $out) { $out = $v.FileVersion }",
      "if ($out) { Write-Output $out }",
    ].join("; ");
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 8000, windowsHide: true },
    );
    const text = String(stdout || "").trim();
    return text || null;
  } catch {
    return null;
  }
}
