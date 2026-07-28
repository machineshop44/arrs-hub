@echo off
title Arrs Hub — remove from Windows Startup
set "SHORTCUT=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Arrs Hub.lnk"

if exist "%SHORTCUT%" (
  del "%SHORTCUT%"
  echo Removed Startup shortcut.
) else (
  echo No Arrs Hub Startup shortcut found.
)

echo.
pause
