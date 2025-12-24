@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

echo.
echo ╔═══════════════════════════════════════════════════════════════╗
echo ║         🔮 TokenSage Proxy Setup                              ║
echo ╠═══════════════════════════════════════════════════════════════╣
echo ║  This script will:                                            ║
echo ║  1. Set up environment variables for proxy                    ║
echo ║  2. Start the proxy server                                    ║
echo ║  3. Open the dashboard in your browser                        ║
echo ╚═══════════════════════════════════════════════════════════════╝
echo.

:: Check if Node.js is installed
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js is not installed. Please install Node.js first.
    pause
    exit /b 1
)

:: Set environment variables for current session
set OPENAI_BASE_URL=http://localhost:4000/v1
set ANTHROPIC_BASE_URL=http://localhost:4000/v1

echo [INFO] Environment variables set:
echo        OPENAI_BASE_URL = %OPENAI_BASE_URL%
echo        ANTHROPIC_BASE_URL = %ANTHROPIC_BASE_URL%
echo.

:: Check if running from project directory
if not exist "package.json" (
    cd /d "%~dp0"
)

:: Install dependencies if needed
if not exist "node_modules" (
    echo [INFO] Installing dependencies...
    call npm install
)

:: Build if needed
if not exist "dist\proxy.js" (
    echo [INFO] Building project...
    call npm run build
)

echo [INFO] Starting TokenSage Proxy Server...
echo.
echo ╔═══════════════════════════════════════════════════════════════╗
echo ║  INSTRUCTIONS:                                                ║
echo ║                                                               ║
echo ║  Option 1: Manual API Configuration in Cursor                 ║
echo ║  ───────────────────────────────────────────────────────────  ║
echo ║  1. Open Cursor Settings (Ctrl+Shift+J)                       ║
echo ║  2. Go to "Models" section                                    ║
echo ║  3. Find "Override OpenAI Base URL"                           ║
echo ║  4. Enter: http://localhost:4000/v1                           ║
echo ║                                                               ║
echo ║  Option 2: Use API Key with Proxy URL                         ║
echo ║  ───────────────────────────────────────────────────────────  ║
echo ║  Run this from terminal where you'll start Cursor:            ║
echo ║  set OPENAI_BASE_URL=http://localhost:4000/v1                 ║
echo ║  start cursor                                                 ║
echo ║                                                               ║
echo ║  Dashboard: http://localhost:4001                             ║
echo ╚═══════════════════════════════════════════════════════════════╝
echo.

:: Open dashboard in browser
timeout /t 2 /nobreak >nul
start http://localhost:4001

:: Start proxy
call npm run proxy

pause
