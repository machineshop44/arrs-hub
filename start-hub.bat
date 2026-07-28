@echo off
title Arrs Hub
cd /d "%~dp0"

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

echo.
echo Starting Arrs Hub (dashboard + sync + port watchdog)...
echo Leave this window open on your Plex PC.
echo Dashboard: http://localhost:3000
echo.
call npm run dev
echo.
echo Hub stopped.
pause
