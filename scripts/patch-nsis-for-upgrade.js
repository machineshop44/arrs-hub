/**
 * Patch electron-builder NSIS templates so upgrades never show
 * "Arrs Hub cannot be closed… Retry" when the silent old uninstaller fails.
 *
 * 1) installUtil.nsh UninstallLoop: after 5 failed uninstall attempts, force-kill
 *    Arrs Hub and continue (no MessageBox). Also drop unused OneMoreAttempt label
 *    (makensis treats unused labels as errors under electron-builder).
 * 2) installSection.nsh: run CHECK_APP_RUNNING on the elevated UAC inner instance
 *    too (assisted install previously skipped it there — where uninstallOldVersion runs).
 *
 * Idempotent. Run before every dist:win (wired via package.json).
 * Never commit the patched node_modules copies.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const nsisDir = path.join(root, "node_modules", "app-builder-lib", "templates", "nsis");
const installUtilPath = path.join(nsisDir, "include", "installUtil.nsh");
const installSectionPath = path.join(nsisDir, "installSection.nsh");

const MARKER_UTIL = "; ARRS-HUB-PATCH: no-retry-messagebox";
const MARKER_SECTION = "; ARRS-HUB-PATCH: check-app-running-inner";

const STOCK_UNINSTALL_RETRY = [
  "    ${if} $R5 > 5",
  '      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY OneMoreAttempt',
  "      Return",
  "    ${endIf}",
  "",
  "  OneMoreAttempt:",
  '    ExecWait \'"$uninstallerFileNameTemp" /S /KEEP_APP_DATA $0 _?=$installationDir\' $R0',
].join("\n");

const PATCHED_UNINSTALL_RETRY = [
  "    ${if} $R5 > 5",
  `      ${MARKER_UTIL}`,
  '      DetailPrint "Old uninstaller still failing - force-killing Arrs Hub and continuing install"',
  // Pop into $R9 so we do not clobber $0 (uninstall flags used by ExecWait)
  '      nsExec::ExecToLog `"$SYSDIR\\cmd.exe" /C taskkill /F /IM "Arrs Hub.exe" /T`',
  "      Pop $R9",
  '      nsExec::ExecToLog `"$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-Process -Name \'Arrs Hub\' -ErrorAction SilentlyContinue | Stop-Process -Force"`',
  "      Pop $R9",
  "      Sleep 1500",
  '      ExecWait \'"$uninstallerFileNameTemp" /S /KEEP_APP_DATA $0 _?=$installationDir\' $R0',
  "      ; Never block on Retry UI - continue install even if old uninstall still fails",
  "      Return",
  "    ${endIf}",
  "",
  // Keep ExecWait fall-through; drop OneMoreAttempt label (unused after MessageBox removal)
  '    ExecWait \'"$uninstallerFileNameTemp" /S /KEEP_APP_DATA $0 _?=$installationDir\' $R0',
].join("\n");

const STOCK_ASSISTED_CHECK = [
  "!else",
  "  ${ifNot} ${UAC_IsInnerInstance}",
  "    !insertmacro CHECK_APP_RUNNING",
  "  ${endif}",
  "!endif",
].join("\n");

const PATCHED_ASSISTED_CHECK = [
  "!else",
  `  ${MARKER_SECTION}`,
  "  ; Always check/stop app on elevated UAC inner instance (runs uninstallOldVersion)",
  "  !insertmacro CHECK_APP_RUNNING",
  "!endif",
].join("\n");

function mustExist(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`[patch-nsis] Missing: ${filePath}`);
    console.error("[patch-nsis] Run npm install first.");
    process.exit(1);
  }
}

function stripUnusedOneMoreAttempt(text) {
  // Fix partially-patched templates that still have the unused label
  if (!text.includes("OneMoreAttempt:")) return { text, changed: false };
  const next = text.replace(/\r?\n  OneMoreAttempt:\r?\n/, "\n");
  return { text: next, changed: next !== text };
}

function patchInstallUtil() {
  let text = fs.readFileSync(installUtilPath, "utf8");

  if (text.includes(MARKER_UTIL)) {
    const fixed = stripUnusedOneMoreAttempt(text);
    if (fixed.changed) {
      fs.writeFileSync(installUtilPath, fixed.text, "utf8");
      console.log("[patch-nsis] installUtil.nsh: removed unused OneMoreAttempt label");
      return true;
    }
    console.log("[patch-nsis] installUtil.nsh: already patched, skipping");
    return false;
  }

  if (!text.includes(STOCK_UNINSTALL_RETRY)) {
    if (text.includes("$(appCannotBeClosed)")) {
      console.error(
        "[patch-nsis] installUtil.nsh: found appCannotBeClosed MessageBox but stock block did not match."
      );
      console.error(
        "[patch-nsis] Update scripts/patch-nsis-for-upgrade.js for this electron-builder version."
      );
      process.exit(1);
    }
    console.log("[patch-nsis] installUtil.nsh: stock pattern not found (already different?) — skipping");
    return false;
  }

  text = text.replace(STOCK_UNINSTALL_RETRY, PATCHED_UNINSTALL_RETRY);
  fs.writeFileSync(installUtilPath, text, "utf8");
  console.log("[patch-nsis] installUtil.nsh: patched");
  return true;
}

function patchInstallSection() {
  let text = fs.readFileSync(installSectionPath, "utf8");

  if (text.includes(MARKER_SECTION)) {
    console.log("[patch-nsis] installSection.nsh: already patched, skipping");
    return false;
  }

  if (!text.includes(STOCK_ASSISTED_CHECK)) {
    if (text.includes("UAC_IsInnerInstance")) {
      console.error(
        "[patch-nsis] installSection.nsh: found UAC_IsInnerInstance skip but stock block did not match."
      );
      console.error(
        "[patch-nsis] Update scripts/patch-nsis-for-upgrade.js for this electron-builder version."
      );
      process.exit(1);
    }
    console.log("[patch-nsis] installSection.nsh: stock pattern not found (already different?) — skipping");
    return false;
  }

  text = text.replace(STOCK_ASSISTED_CHECK, PATCHED_ASSISTED_CHECK);
  fs.writeFileSync(installSectionPath, text, "utf8");
  console.log("[patch-nsis] installSection.nsh: patched");
  return true;
}

mustExist(installUtilPath);
mustExist(installSectionPath);

let changed = 0;
if (patchInstallUtil()) changed += 1;
if (patchInstallSection()) changed += 1;

console.log(`[patch-nsis] Done (${changed} file(s) updated).`);
