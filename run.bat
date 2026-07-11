@echo off
setlocal EnableExtensions
cd /d "%~dp0"

title XLab Token
echo.
echo  === XLab Token ===
echo  Local token usage + cost tracker
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node.js 20+ then retry.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo [1/2] Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
) else (
  echo [1/2] Dependencies OK
)

echo [2/2] Starting server on http://127.0.0.1:3737
echo       Press Ctrl+C to stop.
echo.

start "" cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:3737"
call npm run serve
set EXITCODE=%ERRORLEVEL%

if not "%EXITCODE%"=="0" (
  echo.
  echo [ERROR] Server exited with code %EXITCODE%
  pause
)
exit /b %EXITCODE%
