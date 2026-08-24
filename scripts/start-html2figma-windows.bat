@echo off
setlocal

cd /d "%~dp0\.."

where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js/npm was not found. Install Node.js 20 or newer, then run this launcher again.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )

  echo Installing Playwright Chromium...
  call npx playwright install chromium
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

call npm run app
pause
