@echo off
title Arrs Hub — remove shortcuts
set "DESKTOP=%USERPROFILE%\Desktop\Arrs Hub.lnk"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Arrs Hub.lnk"

if exist "%DESKTOP%" (
  del "%DESKTOP%"
  echo Removed Desktop shortcut.
) else (
  echo No Desktop shortcut found.
)

if exist "%STARTUP%" (
  del "%STARTUP%"
  echo Removed Startup shortcut.
) else (
  echo No Startup shortcut found.
)

echo.
pause
