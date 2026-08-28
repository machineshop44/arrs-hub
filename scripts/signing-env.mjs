/**
 * Optional Authenticode signing for electron-builder / signtool.
 * Set ARRS_SIGN_PFX_PATH + ARRS_SIGN_PFX_PASSWORD (or CSC_LINK / CSC_KEY_PASSWORD).
 */

import fs from "node:fs";

export function resolveSignPfx() {
  const pfx =
    process.env.ARRS_SIGN_PFX_PATH?.trim() ||
    process.env.CSC_LINK?.trim() ||
    "";
  if (!pfx || !fs.existsSync(pfx)) return null;
  return pfx;
}

/** Apply electron-builder signing env when a .pfx is configured. */
export function applyElectronBuilderSigningEnv() {
  const pfx = resolveSignPfx();
  if (!pfx) return false;
  process.env.CSC_LINK = pfx;
  const pass =
    process.env.ARRS_SIGN_PFX_PASSWORD?.trim() ||
    process.env.CSC_KEY_PASSWORD?.trim();
  if (pass) process.env.CSC_KEY_PASSWORD = pass;
  console.log(`[sign] Authenticode enabled via ${pfx}`);
  return true;
}

export function signingStatusLine() {
  return resolveSignPfx()
    ? "Authenticode signing enabled for this build."
    : "Unsigned build (SmartScreen may warn) — set ARRS_SIGN_PFX_PATH to sign.";
}
