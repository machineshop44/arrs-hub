; Aggressively force-stop Arrs Hub before install/uninstall so upgrades do not
; show electron-builder's "cannot be closed… Retry" dialog.
;
; customCheckAppRunning fully replaces _CHECK_APP_RUNNING (no MessageBox).
; Kill also runs in customInit (including elevated UAC inner instance) and
; customUnInit so file locks clear before copy.
; scripts/patch-nsis-for-upgrade.js additionally: (1) force-kills instead of
; MessageBox when silent old uninstall fails, (2) runs CHECK_APP_RUNNING on
; the UAC inner instance where uninstallOldVersion actually runs.
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
!macro tryRenameOneExe EXEPATH
  IfFileExists "${EXEPATH}" 0 +6
    DetailPrint "Renaming locked ${EXEPATH} to drop file lock..."
    Delete "${EXEPATH}.upgrade-old"
    ClearErrors
    Rename "${EXEPATH}" "${EXEPATH}.upgrade-old"
    IfErrors 0 +2
      DetailPrint "Rename failed for ${EXEPATH} (still locked?) — continuing"
!macroend

!macro tryRenameLockedExe
  !insertmacro tryRenameOneExe "$INSTDIR\Arrs Hub.exe"
  !insertmacro tryRenameOneExe "$PROGRAMFILES64\Arrs Hub\Arrs Hub.exe"
  !insertmacro tryRenameOneExe "$PROGRAMFILES\Arrs Hub\Arrs Hub.exe"
  ; Hardcoded fallback matching common elevated install path
  !insertmacro tryRenameOneExe "C:\Program Files\Arrs Hub\Arrs Hub.exe"
!macroend

!macro customInit
  Call forceStopArrsHub
  ; Extra kill aimed at Program Files (per-machine / UAC inner path)
  nsExec::ExecToLog `"$SYSDIR\cmd.exe" /C taskkill /F /IM "Arrs Hub.exe" /T`
  Pop $0
  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $$_.ExecutablePath -like '*\\Arrs Hub\\Arrs Hub.exe' -or $$_.Name -eq 'Arrs Hub.exe' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
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
