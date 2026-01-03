@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

echo.
echo ╔═══════════════════════════════════════════════════════════════╗
echo ║              🔮 TokenSage - Setup Installation                ║
echo ╚═══════════════════════════════════════════════════════════════╝
echo.

:: Check Node.js
echo [1/4] Checking Node.js...
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo       ❌ Node.js not found!
    echo       Please install Node.js from https://nodejs.org/
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('node -v') do set NODE_VER=%%i
echo       ✅ Node.js %NODE_VER% found

:: Check Python (for mitmproxy)
echo.
echo [2/4] Checking Python...
where python >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo       ⚠️  Python not found - mitmproxy features will be limited
    echo       Install Python from https://python.org/ for full tracking
) else (
    for /f "tokens=*" %%i in ('python --version 2^>^&1') do set PY_VER=%%i
    echo       ✅ !PY_VER! found
)

:: Install dependencies
echo.
echo [3/4] Installing dependencies...
cd /d "%~dp0"
call npm install
if %ERRORLEVEL% NEQ 0 (
    echo       ❌ Failed to install dependencies!
    pause
    exit /b 1
)
echo       ✅ Dependencies installed

:: Build project
echo.
echo [4/4] Building project...
call npm run build
if %ERRORLEVEL% NEQ 0 (
    echo       ❌ Build failed!
    pause
    exit /b 1
)
echo       ✅ Build completed

echo.
echo ╔═══════════════════════════════════════════════════════════════╗
echo ║              ✅ Setup Complete!                               ║
echo ╠═══════════════════════════════════════════════════════════════╣
echo ║                                                               ║
echo ║  To start TokenSage, run:  run.bat                            ║
echo ║                                                               ║
echo ║  Dashboard:  http://localhost:4001                            ║
echo ║  Proxy:      http://localhost:4000                            ║
echo ║                                                               ║
echo ╚═══════════════════════════════════════════════════════════════╝
echo.
pause
