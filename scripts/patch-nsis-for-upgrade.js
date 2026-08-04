/**
 * Patch electron-builder NSIS templates so upgrades never show
 * "Arrs Hub cannot be closed… Retry" when the silent old uninstaller fails.
 *
 * 1) installUtil.nsh UninstallLoop: after 5 failed uninstall attempts, force-kill
 *    Arrs Hub and continue (no MessageBox).
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
].join("\n");

const PATCHED_UNINSTALL_RETRY = [
  "    ${if} $R5 > 5",
  `      ${MARKER_UTIL}`,
  '      DetailPrint "Old uninstaller still failing — force-killing Arrs Hub and continuing install"',
  // Pop into $R9 so we do not clobber $0 (uninstall flags used by ExecWait)
  '      nsExec::ExecToLog `"$SYSDIR\\cmd.exe" /C taskkill /F /IM "Arrs Hub.exe" /T`',
  "      Pop $R9",
  '      nsExec::ExecToLog `"$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-Process -Name \'Arrs Hub\' -ErrorAction SilentlyContinue | Stop-Process -Force"`',
  "      Pop $R9",
  "      Sleep 1500",
  '      ExecWait \'"$uninstallerFileNameTemp" /S /KEEP_APP_DATA $0 _?=$installationDir\' $R0',
  "      ; Never block on Retry UI — continue install even if old uninstall still fails",
  "      Return",
  "    ${endIf}",
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

function patchFile(filePath, stock, patched, marker, label) {
  let text = fs.readFileSync(filePath, "utf8");

  if (text.includes(marker)) {
    console.log(`[patch-nsis] ${label}: already patched, skipping`);
    return false;
  }

  if (!text.includes(stock)) {
    if (label === "installUtil.nsh" && text.includes("$(appCannotBeClosed)")) {
      console.error(
        `[patch-nsis] ${label}: found appCannotBeClosed MessageBox but stock block did not match.`
      );
      console.error(
        "[patch-nsis] Update scripts/patch-nsis-for-upgrade.js for this electron-builder version."
      );
      process.exit(1);
    }
    if (label === "installSection.nsh" && text.includes("UAC_IsInnerInstance")) {
      console.error(
        `[patch-nsis] ${label}: found UAC_IsInnerInstance skip but stock block did not match.`
      );
      console.error(
        "[patch-nsis] Update scripts/patch-nsis-for-upgrade.js for this electron-builder version."
      );
      process.exit(1);
    }
    console.log(`[patch-nsis] ${label}: stock pattern not found (already different?) — skipping`);
    return false;
  }

  text = text.replace(stock, patched);
  fs.writeFileSync(filePath, text, "utf8");
  console.log(`[patch-nsis] ${label}: patched`);
  return true;
}

mustExist(installUtilPath);
mustExist(installSectionPath);

let changed = 0;
if (
  patchFile(installUtilPath, STOCK_UNINSTALL_RETRY, PATCHED_UNINSTALL_RETRY, MARKER_UTIL, "installUtil.nsh")
) {
  changed += 1;
}
if (
  patchFile(
    installSectionPath,
    STOCK_ASSISTED_CHECK,
    PATCHED_ASSISTED_CHECK,
    MARKER_SECTION,
    "installSection.nsh"
  )
) {
  changed += 1;
}

console.log(`[patch-nsis] Done (${changed} file(s) updated).`);
