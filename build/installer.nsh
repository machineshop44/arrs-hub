; Aggressively force-stop Arrs Hub before install/uninstall so upgrades do not
; show electron-builder's "cannot be closed… Retry" dialog.
;
; customCheckAppRunning fully replaces _CHECK_APP_RUNNING (no MessageBox).
; Kill also runs in customInit (including elevated UAC inner instance) and
; customUnInit so file locks clear before copy.
; scripts/patch-nsis-for-upgrade.js additionally:
;   (1) UninstallLoop: kill first, ≤2 silent uninstall tries, then continue
;       (never MessageBox / Retry — overwrite install if old uninstall fails)
;   (2) extractAppPackage: kill + non-atomic extract fallback (never Retry UI)
;   (3) CHECK_APP_RUNNING on UAC inner instance where uninstallOldVersion runs
;   (4) allowOnlyOneInstallerInstance: no Retry MessageBox if check-app-running loops
;
; Note: avoid LogicLib (${If}) here — custom include is parsed before LogicLib.

!macro DefineForceStopArrsHub un
  Function ${un}forceStopArrsHub
    DetailPrint "Force-stopping Arrs Hub processes..."

    ; Attempt 1
    nsExec::ExecToLog `"$SYSDIR\cmd.exe" /C taskkill /F /IM "Arrs Hub.exe" /T`
    Pop $0
    nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-Process -Name 'Arrs Hub' -ErrorAction SilentlyContinue | Stop-Process -Force"`
    Pop $0
    Sleep 500

    ; Attempt 2
    nsExec::ExecToLog `"$SYSDIR\cmd.exe" /C taskkill /F /IM "Arrs Hub.exe" /T`
    Pop $0
    nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-Process -Name 'Arrs Hub' -ErrorAction SilentlyContinue | Stop-Process -Force"`
    Pop $0
    Sleep 600

    ; Attempt 3
    nsExec::ExecToLog `"$SYSDIR\cmd.exe" /C taskkill /F /IM "Arrs Hub.exe" /T`
    Pop $0
    nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-Process -Name 'Arrs Hub' -ErrorAction SilentlyContinue | Stop-Process -Force"`
    Pop $0
    Sleep 700

    ; Attempt 4 — CIM fallback for stubborn orphans
    nsExec::ExecToLog `"$SYSDIR\cmd.exe" /C taskkill /F /IM "Arrs Hub.exe" /T`
    Pop $0
    nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $$_.Name -eq 'Arrs Hub.exe' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
    Pop $0
    Sleep 800

    ; Attempt 5 — final combined sweep
    nsExec::ExecToLog `"$SYSDIR\cmd.exe" /C taskkill /F /IM "Arrs Hub.exe" /T`
    Pop $0
    nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-Process -Name 'Arrs Hub' -ErrorAction SilentlyContinue | Stop-Process -Force; Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $$_.Name -eq 'Arrs Hub.exe' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
    Pop $0
    Sleep 1000

    ; Settle so file locks release before NSIS copies over $INSTDIR
    Sleep 400
  FunctionEnd
!macroend

!ifdef BUILD_UNINSTALLER
  !insertmacro DefineForceStopArrsHub "un."
!else
  !insertmacro DefineForceStopArrsHub ""
!endif

; Try to drop file locks by renaming the old exe out of the way (upgrade path).
; Safe no-op if missing or still locked after kill.
; Per-machine installs land under Program Files; $INSTDIR may still be unset/wrong
; in customInit on the elevated UAC inner instance, so hit that path explicitly.
; (Do not pass paths-with-spaces as !insertmacro args — NSIS splits on whitespace.)
!macro tryRenameLockedExe
  IfFileExists "$INSTDIR\Arrs Hub.exe" 0 arrs_hub_rn_instdir_done
    DetailPrint "Renaming $INSTDIR\Arrs Hub.exe to drop file lock..."
    Delete "$INSTDIR\Arrs Hub.exe.upgrade-old"
    ClearErrors
    Rename "$INSTDIR\Arrs Hub.exe" "$INSTDIR\Arrs Hub.exe.upgrade-old"
  arrs_hub_rn_instdir_done:

  IfFileExists "$PROGRAMFILES64\Arrs Hub\Arrs Hub.exe" 0 arrs_hub_rn_pf64_done
    DetailPrint "Renaming Program Files (x64) Arrs Hub.exe to drop file lock..."
    Delete "$PROGRAMFILES64\Arrs Hub\Arrs Hub.exe.upgrade-old"
    ClearErrors
    Rename "$PROGRAMFILES64\Arrs Hub\Arrs Hub.exe" "$PROGRAMFILES64\Arrs Hub\Arrs Hub.exe.upgrade-old"
  arrs_hub_rn_pf64_done:

  IfFileExists "$PROGRAMFILES\Arrs Hub\Arrs Hub.exe" 0 arrs_hub_rn_pf_done
    DetailPrint "Renaming Program Files Arrs Hub.exe to drop file lock..."
    Delete "$PROGRAMFILES\Arrs Hub\Arrs Hub.exe.upgrade-old"
    ClearErrors
    Rename "$PROGRAMFILES\Arrs Hub\Arrs Hub.exe" "$PROGRAMFILES\Arrs Hub\Arrs Hub.exe.upgrade-old"
  arrs_hub_rn_pf_done:
!macroend

!macro customInit
  Call forceStopArrsHub
  ; Extra kill aimed at Program Files (per-machine / UAC inner path)
  nsExec::ExecToLog `"$SYSDIR\cmd.exe" /C taskkill /F /IM "Arrs Hub.exe" /T`
  Pop $0
  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $$_.Name -eq 'Arrs Hub.exe' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
  Pop $0
  Sleep 800
  !insertmacro tryRenameLockedExe
!macroend

; Replaces electron-builder default _CHECK_APP_RUNNING entirely — never MessageBox.
; Used by both installer and uninstaller (un.* Function required in uninstall builds).
!macro customCheckAppRunning
  !ifdef BUILD_UNINSTALLER
    Call un.forceStopArrsHub
  !else
    Call forceStopArrsHub
  !endif
!macroend

!macro customUnInit
  Call un.forceStopArrsHub
!macroend
