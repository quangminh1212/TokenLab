@echo off
setlocal EnableExtensions
cd /d "%~dp0"

title XLab Token (hot reload)
echo.
echo  === XLab Token ===
echo  Dev server + hot reload (tsx watch)
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node.js 20+ then retry.
  pause
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo [ERROR] npm not found. Install Node.js 20+ then retry.
  pause
  exit /b 1
)

echo [1/2] Installing dependencies...
if not exist "node_modules\" (
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
) else (
  echo       node_modules OK
)

if not exist "node_modules\tsx\" (
  echo       Installing tsx...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

echo [2/2] Starting hot-reload server on http://127.0.0.1:3737
echo       Watching: src\
echo       Edit code -^> server auto-restarts
echo       Press Ctrl+C to stop.
echo.

start "" cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:3737"
call npm run serve:watch
set EXITCODE=%ERRORLEVEL%

if not "%EXITCODE%"=="0" (
  echo.
  echo [ERROR] Server exited with code %EXITCODE%
  pause
)
exit /b %EXITCODE%
