; Aggressively force-stop Arrs Hub before install/uninstall so upgrades do not
; show electron-builder's "cannot be closed… Retry" dialog.
;
; customCheckAppRunning fully replaces _CHECK_APP_RUNNING (no MessageBox).
; Kill also runs in customInit (including elevated UAC inner instance, which
; skips CHECK_APP_RUNNING) and customUnInit so file locks clear before copy.
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

!macro customInit
  Call forceStopArrsHub
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
