; Force-stop Arrs Hub Companion before install/uninstall (same upgrade strategy as Arrs Hub).
; scripts/patch-nsis-for-upgrade.js also patches shared electron-builder templates.

!macro DefineForceStopCompanion un
  Function ${un}forceStopCompanion
    DetailPrint "Force-stopping Arrs Hub Companion processes..."
    nsExec::ExecToLog `"$SYSDIR\cmd.exe" /C taskkill /F /IM "Arrs Hub Companion.exe" /T`
    Pop $0
    nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-Process -Name 'Arrs Hub Companion' -ErrorAction SilentlyContinue | Stop-Process -Force"`
    Pop $0
    Sleep 500
    nsExec::ExecToLog `"$SYSDIR\cmd.exe" /C taskkill /F /IM "Arrs Hub Companion.exe" /T`
    Pop $0
    nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $$_.Name -eq 'Arrs Hub Companion.exe' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
    Pop $0
    Sleep 800
  FunctionEnd
!macroend

!ifdef BUILD_UNINSTALLER
  !insertmacro DefineForceStopCompanion "un."
!else
  !insertmacro DefineForceStopCompanion ""
!endif

!macro tryRenameLockedCompanionExe
  IfFileExists "$INSTDIR\Arrs Hub Companion.exe" 0 arrs_comp_rn_done
    DetailPrint "Renaming Arrs Hub Companion.exe to drop file lock..."
    Delete "$INSTDIR\Arrs Hub Companion.exe.upgrade-old"
    ClearErrors
    Rename "$INSTDIR\Arrs Hub Companion.exe" "$INSTDIR\Arrs Hub Companion.exe.upgrade-old"
  arrs_comp_rn_done:
!macroend

!macro customInit
  Call forceStopCompanion
  Sleep 600
  !insertmacro tryRenameLockedCompanionExe
!macroend

!macro customCheckAppRunning
  !ifdef BUILD_UNINSTALLER
    Call un.forceStopCompanion
  !else
    Call forceStopCompanion
  !endif
!macroend

!macro customUnInit
  Call un.forceStopCompanion
!macroend
