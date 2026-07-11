@echo off
setlocal EnableExtensions
cd /d "%~dp0"

title XLab Token
echo.
echo  === XLab Token ===
echo  Build + start local server
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

echo [1/3] Installing dependencies...
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

echo [2/3] Building project...
call npm run build
if errorlevel 1 (
  echo [ERROR] Build failed.
  pause
  exit /b 1
)

if not exist "dist\cli.js" (
  echo [ERROR] dist\cli.js missing after build.
  pause
  exit /b 1
)

echo [3/3] Starting server on http://127.0.0.1:3737
echo       Press Ctrl+C to stop.
echo.

start "" cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:3737"
call node dist\cli.js serve
set EXITCODE=%ERRORLEVEL%

if not "%EXITCODE%"=="0" (
  echo.
  echo [ERROR] Server exited with code %EXITCODE%
  pause
)
exit /b %EXITCODE%
