/**
 * Patch electron-builder NSIS templates so upgrades never show
 * "Arrs Hub cannot be closed… Retry" when silent old uninstall / file copy fails.
 *
 * 1) installUtil.nsh UninstallLoop: kill Arrs Hub first, try silent uninstall at most
 *    twice, then continue install (overwrite) — never MessageBox / Retry.
 * 2) extractAppPackage.nsh: on locked CopyFiles, force-kill + non-atomic extract
 *    fallback — never MessageBox / Retry / Quit.
 * 3) installSection.nsh: always CHECK_APP_RUNNING on elevated UAC inner instance.
 *
 * Idempotent (marker-based). Run before every dist:win (wired via package.json).
 * Never commit the patched node_modules copies.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const nsisDir = path.join(root, "node_modules", "app-builder-lib", "templates", "nsis");
const installUtilPath = path.join(nsisDir, "include", "installUtil.nsh");
const extractAppPackagePath = path.join(nsisDir, "include", "extractAppPackage.nsh");
const installSectionPath = path.join(nsisDir, "installSection.nsh");

const MARKER_UTIL = "; ARRS-HUB-PATCH: no-retry-messagebox";
const MARKER_UTIL_V2 = "; ARRS-HUB-PATCH: no-retry-messagebox v2";
const MARKER_EXTRACT = "; ARRS-HUB-PATCH: no-extract-retry-messagebox";
const MARKER_SECTION = "; ARRS-HUB-PATCH: check-app-running-inner";

const FORCE_KILL_NSIS = [
  '    nsExec::ExecToLog `"$SYSDIR\\cmd.exe" /C taskkill /F /IM "Arrs Hub.exe" /T`',
  "    Pop $R9",
  '    nsExec::ExecToLog `"$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-Process -Name \'Arrs Hub\' -ErrorAction SilentlyContinue | Stop-Process -Force; Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $$_.Name -eq \'Arrs Hub.exe\' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`',
  "    Pop $R9",
].join("\n");

/** Replace UninstallLoop body: kill early, ≤2 attempts, never MessageBox.
 *  No UninstallLoop label — Goto was removed and unused labels fail makensis.
 */
const UNINSTALL_LOOP_REPLACEMENT = [
  `  ${MARKER_UTIL}`,
  `  ${MARKER_UTIL_V2}`,
  '  DetailPrint "Upgrade: force-stopping Arrs Hub before old silent uninstall"',
  // FORCE_KILL lines are indented with 4 spaces; bump would misalign — keep as-is (NSIS ignores indent)
  FORCE_KILL_NSIS,
  "  Sleep 800",
  "",
  "  ; Attempt 1",
  '  ExecWait \'"$uninstallerFileNameTemp" /S /KEEP_APP_DATA $0 _?=$installationDir\' $R0',
  "  ifErrors TryInPlace CheckResult",
  "",
  "  TryInPlace:",
  "  # the execution failed - might have been caused by some group policy restrictions",
  "  # we try to execute the uninstaller in place",
  '  ExecWait \'"$uninstallerFileName" /S /KEEP_APP_DATA $0 _?=$installationDir\' $R0',
  "  ifErrors DoesNotExist",
  "",
  "  CheckResult:",
  "  ${if} $R0 == 0",
  "    Return",
  "  ${endIf}",
  "",
  "  ; First silent uninstall failed (app may already be gone / files locked).",
  "  ; Kill again, one more try, then continue install — never show Retry UI.",
  '  DetailPrint "Old silent uninstall failed — force-kill and continue without Retry dialog"',
  FORCE_KILL_NSIS,
  "  Sleep 1000",
  '  ExecWait \'"$uninstallerFileNameTemp" /S /KEEP_APP_DATA $0 _?=$installationDir\' $R0',
  "  ${if} $R0 == 0",
  "    Return",
  "  ${endIf}",
  "  ; Proceed with file overwrite install even if old uninstall still fails",
  "  ClearErrors",
  "  Return",
  "",
  "  DoesNotExist:",
].join("\n");

const EXTRACT_AFTER_FAIL_REPLACEMENT = [
  "    DetailPrint `Can't modify \"${PRODUCT_NAME}\"'s files.`",
  "    ${if} $R1 < 3",
  `      ${MARKER_EXTRACT}`,
  '      DetailPrint "Locked files during extract — force-stopping Arrs Hub and retrying copy"',
  '      nsExec::ExecToLog `"$SYSDIR\\cmd.exe" /C taskkill /F /IM "Arrs Hub.exe" /T`',
  "      Pop $R9",
  '      nsExec::ExecToLog `"$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-Process -Name \'Arrs Hub\' -ErrorAction SilentlyContinue | Stop-Process -Force"`',
  "      Pop $R9",
  "      Sleep 800",
  "      Goto RetryExtract7za",
  "    ${else}",
  "      ; Never show Retry MessageBox — fall through to non-atomic Nsis7z extract",
  '      DetailPrint "Copy still locked — force-kill then non-atomic extract (no Retry UI)"',
  '      nsExec::ExecToLog `"$SYSDIR\\cmd.exe" /C taskkill /F /IM "Arrs Hub.exe" /T`',
  "      Pop $R9",
  "      Sleep 500",
  "    ${endIf}",
].join("\n");

function mustExist(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`[patch-nsis] Missing: ${filePath}`);
    console.error("[patch-nsis] Run npm install first.");
    process.exit(1);
  }
}

function normalizeNewlines(text) {
  return text.replace(/\r\n/g, "\n");
}

function stripAppCannotBeClosedMessageBoxes(text, label) {
  // Aggressive: any MB_RETRYCANCEL appCannotBeClosed line (stock wording varies by version)
  const next = text.replace(
    /^[ \t]*MessageBox[ \t]+MB_RETRYCANCEL\|MB_ICONEXCLAMATION[ \t]+"\$\(appCannotBeClosed\)"[^\r\n]*\r?\n/gm,
    ""
  );
  if (next !== text) {
    console.log(`[patch-nsis] ${label}: stripped appCannotBeClosed MessageBox line(s)`);
  }
  return next;
}

function patchInstallUtil() {
  let text = normalizeNewlines(fs.readFileSync(installUtilPath, "utf8"));
  const hadV2 = text.includes(MARKER_UTIL_V2);

  // Replace entire UninstallLoop … DoesNotExist: (stock) or prior v2 block … DoesNotExist:
  const loopRe = /(?:  UninstallLoop:|  ; ARRS-HUB-PATCH: no-retry-messagebox)[\s\S]*?\n  DoesNotExist:/;
  if (!loopRe.test(text)) {
    console.error("[patch-nsis] installUtil.nsh: UninstallLoop / patch block not found.");
    process.exit(1);
  }

  // Also drop stale "# Retry counter" + StrCpy $R5 0 when present
  text = text.replace(/\n  # Retry counter\n  StrCpy \$R5 0\n/g, "\n");

  // Function replacer: string replace treats $$ as escape and would collapse NSIS $$_ → $_
  text = text.replace(loopRe, () => UNINSTALL_LOOP_REPLACEMENT);
  text = stripAppCannotBeClosedMessageBoxes(text, "installUtil.nsh");

  // Drop orphaned OneMoreAttempt label if any remain
  text = text.replace(/\n  OneMoreAttempt:\n/g, "\n");

  if (text.includes("$(appCannotBeClosed)") && text.includes("MessageBox")) {
    // Still referenced from MessageBox somewhere in this file — fail loud
    if (/MessageBox[^\n]*appCannotBeClosed/.test(text)) {
      console.error("[patch-nsis] installUtil.nsh: MessageBox appCannotBeClosed still present after patch.");
      process.exit(1);
    }
  }

  fs.writeFileSync(installUtilPath, text, "utf8");
  console.log(
    hadV2
      ? "[patch-nsis] installUtil.nsh: refreshed v2 UninstallLoop"
      : "[patch-nsis] installUtil.nsh: patched UninstallLoop (v2, no Retry)"
  );
  return true;
}

function patchExtractAppPackage() {
  let text = normalizeNewlines(fs.readFileSync(extractAppPackagePath, "utf8"));

  if (text.includes(MARKER_EXTRACT) && !/MessageBox[^\n]*appCannotBeClosed/.test(text)) {
    console.log("[patch-nsis] extractAppPackage.nsh: already patched, skipping");
    return false;
  }

  // Stock: DetailPrint + ${if} $R1 < 5 … MessageBox … ${endIf}
  const stockRe =
    /    DetailPrint `Can't modify "\$\{PRODUCT_NAME\}"'s files\.`\n    \$\{if\} \$R1 < 5\n[\s\S]*?\$\{endIf\}/;

  if (!stockRe.test(text)) {
    // Already partially patched or different layout — strip MessageBox and inject marker path
    if (/MessageBox[^\n]*appCannotBeClosed/.test(text)) {
      text = stripAppCannotBeClosedMessageBoxes(text, "extractAppPackage.nsh");
      // After stripping MessageBox, empty ${else} may remain — replace common leftover
      text = text.replace(
        /    DetailPrint `Can't modify "\$\{PRODUCT_NAME\}"'s files\.`\n    \$\{if\} \$R1 < 5\n[\s\S]*?\$\{endIf\}/,
        EXTRACT_AFTER_FAIL_REPLACEMENT
      );
      if (/MessageBox[^\n]*appCannotBeClosed/.test(text)) {
        console.error(
          "[patch-nsis] extractAppPackage.nsh: could not fully remove appCannotBeClosed MessageBox."
        );
        process.exit(1);
      }
      if (!text.includes(MARKER_EXTRACT)) {
        // Ensure marker exists near LoopExtract7za for idempotency
        text = text.replace(
          "  LoopExtract7za:",
          `  LoopExtract7za:\n    ${MARKER_EXTRACT}`
        );
      }
      fs.writeFileSync(extractAppPackagePath, text, "utf8");
      console.log("[patch-nsis] extractAppPackage.nsh: patched (fallback path)");
      return true;
    }
    console.log("[patch-nsis] extractAppPackage.nsh: stock pattern not found — skipping");
    return false;
  }

  text = text.replace(stockRe, () => EXTRACT_AFTER_FAIL_REPLACEMENT);
  text = stripAppCannotBeClosedMessageBoxes(text, "extractAppPackage.nsh");
  // MessageBox used to jump here — remove unused label (makensis error under electron-builder)
  text = text.replace(/\n  AbortExtract7za:\n    Quit\n/g, "\n");

  if (/MessageBox[^\n]*appCannotBeClosed/.test(text)) {
    console.error("[patch-nsis] extractAppPackage.nsh: MessageBox still present after patch.");
    process.exit(1);
  }

  fs.writeFileSync(extractAppPackagePath, text, "utf8");
  console.log("[patch-nsis] extractAppPackage.nsh: patched (no Retry MessageBox)");
  return true;
}

function patchInstallSection() {
  let text = normalizeNewlines(fs.readFileSync(installSectionPath, "utf8"));

  if (text.includes(MARKER_SECTION)) {
    console.log("[patch-nsis] installSection.nsh: already patched, skipping");
    return false;
  }

  const stockRe =
    /!else\n  \$\{ifNot\} \$\{UAC_IsInnerInstance\}\n    !insertmacro CHECK_APP_RUNNING\n  \$\{endif\}\n!endif/;

  const patched = [
    "!else",
    `  ${MARKER_SECTION}`,
    "  ; Always check/stop app on elevated UAC inner instance (runs uninstallOldVersion)",
    "  !insertmacro CHECK_APP_RUNNING",
    "!endif",
  ].join("\n");

  if (!stockRe.test(text)) {
    if (text.includes("UAC_IsInnerInstance")) {
      console.error(
        "[patch-nsis] installSection.nsh: found UAC_IsInnerInstance skip but stock block did not match."
      );
      process.exit(1);
    }
    console.log("[patch-nsis] installSection.nsh: stock pattern not found — skipping");
    return false;
  }

  text = text.replace(stockRe, patched);
  fs.writeFileSync(installSectionPath, text, "utf8");
  console.log("[patch-nsis] installSection.nsh: patched");
  return true;
}

mustExist(installUtilPath);
mustExist(extractAppPackagePath);
mustExist(installSectionPath);

let changed = 0;
if (patchInstallUtil()) changed += 1;
if (patchExtractAppPackage()) changed += 1;
if (patchInstallSection()) changed += 1;

console.log(`[patch-nsis] Done (${changed} file(s) updated).`);
