@echo off
title Arrs Hub — Desktop shortcut + Startup
cd /d "%~dp0"

set "DESKTOP=%USERPROFILE%\Desktop"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "TARGET=%~dp0Start Arrs Hub.vbs"
set "ICON=%~dp0desktop\icon.png"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ws = New-Object -ComObject WScript.Shell;" ^
  "$paths = @('%DESKTOP%\Arrs Hub.lnk', '%STARTUP%\Arrs Hub.lnk');" ^
  "foreach ($p in $paths) {" ^
  "  $s = $ws.CreateShortcut($p);" ^
  "  $s.TargetPath = '%TARGET%';" ^
  "  $s.WorkingDirectory = '%~dp0';" ^
  "  $s.WindowStyle = 7;" ^
  "  $s.Description = 'Arrs Hub';" ^
  "  $s.Save();" ^
  "  Write-Host ('Created ' + $p);" ^
  "}"

echo.
echo Created Desktop + Startup shortcuts to Arrs Hub.
echo Double-click the Desktop icon anytime. Close the window to keep it in the tray;
echo right-click the tray icon -^> Quit to fully stop.
echo.
pause
