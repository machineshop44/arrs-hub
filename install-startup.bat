@echo off
title Arrs Hub — add to Windows Startup
cd /d "%~dp0"

set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "SHORTCUT=%STARTUP%\Arrs Hub.lnk"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%SHORTCUT%'); $s.TargetPath = '%~dp0start-hub.bat'; $s.WorkingDirectory = '%~dp0'; $s.WindowStyle = 1; $s.Description = 'Start Arrs Hub with Windows'; $s.Save()"

if exist "%SHORTCUT%" (
  echo Added Startup shortcut:
  echo   %SHORTCUT%
  echo.
  echo Arrs Hub will start when you sign in to Windows.
  echo A console window will open — leave it running.
) else (
  echo Failed to create Startup shortcut.
)

echo.
pause
