@echo off
rem Double-click launcher for the dsh desktop app (builds, then opens Electron).
rem Needs one prior `pnpm install`; later runs are incremental.
rem Extra args forward, e.g. run_desktop.bat --skip-build
setlocal
cd /d "%~dp0"

call :pick_pnpm || exit /b 1

%PNPM% run dev:desktop %*
if errorlevel 1 (
  echo.
  echo [run-desktop] exited with code %errorlevel%. See the output above.
  pause
  exit /b 1
)
goto :eof

:pick_pnpm
where pnpm >nul 2>nul
if not errorlevel 1 (
  set "PNPM=call pnpm"
  exit /b 0
)
where npx >nul 2>nul
if not errorlevel 1 (
  set "PNPM=call npx --yes pnpm@11.7.0"
  exit /b 0
)
echo [run-desktop] Neither pnpm nor npx was found. Install Node.js 22+ from https://nodejs.org/ and retry.
pause
exit /b 1
