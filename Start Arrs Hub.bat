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
  echo Installing dependencies ^(first run^)...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo Installing Electron desktop shell...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

if not exist "dist\index.html" (
  echo Building Arrs Hub UI ^(first run^)...
  call npm run build
  if errorlevel 1 (
    echo Build failed.
    pause
    exit /b 1
  )
)

echo Freeing ports 3000 and 3847 if an old hub is still running...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ports = 3000,3847; foreach ($port in $ports) { Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $procId = $_.OwningProcess; if ($procId -and $procId -ne 0) { Write-Host ('Stopping PID ' + $procId + ' on port ' + $port); Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue } } }"

echo Starting Arrs Hub ^(app window + tray icon^)...
REM Use "." after cd — a trailing backslash in %%~dp0 breaks Electron's path parsing.
start "" "%CD%\node_modules\electron\dist\electron.exe" .
exit /b 0
