@echo off
title Arrs Hub — Desktop shortcut + Startup
cd /d "%~dp0"

set "DESKTOP=%USERPROFILE%\Desktop"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "TARGET=%~dp0Start Arrs Hub.vbs"
set "ICON=%~dp0desktop\icon.ico"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ws = New-Object -ComObject WScript.Shell;" ^
  "$icon = '%ICON%';" ^
  "$target = '%TARGET%';" ^
  "$paths = @('%DESKTOP%\Arrs Hub.lnk', '%STARTUP%\Arrs Hub.lnk');" ^
  "foreach ($p in $paths) {" ^
  "  $s = $ws.CreateShortcut($p);" ^
  "  $s.TargetPath = 'wscript.exe';" ^
  "  $s.Arguments = [char]34 + $target + [char]34;" ^
  "  $s.WorkingDirectory = '%~dp0';" ^
  "  if (Test-Path -LiteralPath $icon) { $s.IconLocation = ($icon + ',0') }" ^
  "  $s.WindowStyle = 7;" ^
  "  $s.Description = 'Arrs Hub';" ^
  "  $s.Save();" ^
  "  Write-Host ('Created ' + $p);" ^
  "}"

echo.
echo Created Desktop + Startup shortcuts with the Arrs house icon.
echo.
echo How to restart after quitting the tray:
echo   Double-click the Desktop "Arrs Hub" icon
echo   or double-click "Start Arrs Hub.vbs" in this folder
echo.
echo Close window = stays in tray. Tray -^> Quit = fully stop.
echo.
pause
