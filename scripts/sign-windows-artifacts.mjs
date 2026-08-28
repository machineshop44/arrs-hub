/**
 * Sign Windows .exe artifacts with signtool when ARRS_SIGN_PFX_PATH is set.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveSignPfx } from "./signing-env.mjs";

function findSigntool() {
  const fromEnv = process.env.SIGNTOOL_PATH?.trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const result = spawnSync("where.exe", ["signtool"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status === 0) {
    const line = result.stdout.split(/\r?\n/).find((l) => l.trim());
    if (line && fs.existsSync(line.trim())) return line.trim();
  }
  return "signtool";
}

/**
 * @param {string[]} filePaths
 * @returns {number} count signed
 */
export function signWindowsArtifacts(filePaths) {
  const pfx = resolveSignPfx();
  if (!pfx) return 0;

  const pass =
    process.env.ARRS_SIGN_PFX_PASSWORD?.trim() ||
    process.env.CSC_KEY_PASSWORD?.trim() ||
    "";
  const signtool = findSigntool();
  const timestamp =
    process.env.ARRS_SIGN_TIMESTAMP_URL?.trim() ||
    "http://timestamp.digicert.com";

  let signed = 0;
  for (const filePath of filePaths) {
    if (!filePath || !fs.existsSync(filePath)) continue;
    const args = [
      "sign",
      "/fd",
      "sha256",
      "/td",
      "sha256",
      "/tr",
      timestamp,
      "/f",
      pfx,
    ];
    if (pass) args.push("/p", pass);
    args.push(filePath);

    console.log(`[sign] ${path.basename(filePath)} …`);
    const result = spawnSync(signtool, args, {
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.status !== 0) {
      throw new Error(`signtool failed for ${filePath}`);
    }
    signed += 1;
  }
  return signed;
}
