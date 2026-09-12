@echo off
rem Double-click launcher for the dsh web GUI: client-bundle watcher plus server.
rem Needs one prior `pnpm install` and `pnpm run build`; later runs are incremental.
rem Extra args forward to `dsh web`, e.g. run_web.bat --no-open --port 5101
setlocal
cd /d "%~dp0"

call :pick_pnpm || exit /b 1

echo [run-web] Starting client-bundle watcher in a second window...
start "dsh dev:web" /d "%~dp0" cmd /k %PNPM% run dev:web
echo [run-web] Starting web server in this window (Ctrl+C to stop)...
%PNPM% dsh web %*
if errorlevel 1 (
  echo.
  echo [run-web] exited with code %errorlevel%. See the output above.
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
echo [run-web] Neither pnpm nor npx was found. Install Node.js 22+ from https://nodejs.org/ and retry.
pause
exit /b 1
