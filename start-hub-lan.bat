@echo off
title Arrs Hub (LAN bind for phone companion)
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not installed or not on PATH.
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

set "NODE_OPTIONS=%NODE_OPTIONS% --use-system-ca"
set "ARRS_HUB_BIND=0.0.0.0"

echo.
echo Starting Arrs Hub with LAN bind (phone companion)...
echo Dashboard: http://localhost:3000
echo Phone URL: http://^<this-pc-lan-ip^>:3847
echo Leave this window open. Allow Windows Firewall for Node/port 3847 if prompted.
echo.
call npm run dev
echo.
echo Hub stopped.
pause
