; Force-stop Arrs Hub (main + ELECTRON_RUN_AS_NODE server child) before
; file copy so upgrades don't show "cannot be closed… Retry".

!macro customInit
  nsExec::ExecToLog 'taskkill /F /IM "Arrs Hub.exe" /T'
  Sleep 400
!macroend

!macro customCheckAppRunning
  nsExec::ExecToLog 'taskkill /F /IM "Arrs Hub.exe" /T'
  Sleep 400
!macroend

!macro customUnInit
  nsExec::ExecToLog 'taskkill /F /IM "Arrs Hub.exe" /T'
  Sleep 400
!macroend
