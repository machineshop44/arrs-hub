@echo off
cd /d C:\Users\machi\Desktop\Arrs-Hub
echo Working in %CD%
echo.

where git >nul 2>&1
if errorlevel 1 (
  echo ERROR: Git is not installed.
  pause
  exit /b 1
)

where gh >nul 2>&1
if errorlevel 1 (
  echo ERROR: GitHub CLI not found.
  echo Install with: winget install --id GitHub.cli -e
  pause
  exit /b 1
)

gh auth status
if errorlevel 1 (
  echo.
  echo Not logged in to GitHub CLI.
  echo Run this, then re-run this script:
  echo   gh auth login
  pause
  exit /b 1
)

if not exist .git (
  git init
)
git branch -M main
git add .
git status
git diff --cached --quiet
if errorlevel 1 (
  git commit -m "Initial Arrs Hub dashboard for Plex and arr stack."
)

git remote remove origin 2>nul
gh repo create arrs-hub --private --source=. --remote=origin --push
if errorlevel 1 (
  echo.
  echo Name arrs-hub may already exist. Trying arrs-hub-dashboard...
  git remote remove origin 2>nul
  gh repo create arrs-hub-dashboard --private --source=. --remote=origin --push
)

echo.
echo ==============================
echo Done. Your repo URL:
gh repo view --json url -q .url
echo ==============================
pause
