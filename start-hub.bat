@echo off
title Arrs Hub (console / developer mode)
cd /d "%~dp0"

REM Prefer the tray app for normal use: double-click "Start Arrs Hub.vbs"
REM This bat keeps the old console-based npm run dev workflow.

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not installed or not on PATH.
  echo Install LTS from https://nodejs.org then try again.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

echo Freeing ports 3000 and 3847 if an old hub is still running...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ports = 3000,3847; foreach ($port in $ports) { Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $procId = $_.OwningProcess; if ($procId -and $procId -ne 0) { Write-Host ('Stopping PID ' + $procId + ' on port ' + $port); Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue } } }"

REM Needed for plex.tv login TLS on machines with custom/corporate CAs
set "NODE_OPTIONS=%NODE_OPTIONS% --use-system-ca"

echo.
echo Starting Arrs Hub (dashboard + sync + port watchdog)...
echo Leave this window open on your Plex PC.
echo Dashboard: http://localhost:3000
echo.
call npm run dev
echo.
echo Hub stopped.
pause
