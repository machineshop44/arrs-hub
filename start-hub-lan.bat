@echo off
title Arrs Hub (LAN / mobile reachable)
cd /d "%~dp0"

REM Thin wrapper — normal Start Arrs Hub / exe already binds 0.0.0.0 by default.
REM Kept for clarity / docs; same as start-hub.bat with ARRS_HUB_BIND explicit.

set "ARRS_HUB_BIND=0.0.0.0"
call "%~dp0start-hub.bat" %*
