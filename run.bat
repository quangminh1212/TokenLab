@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

echo.
echo ╔═══════════════════════════════════════════════════════════════╗
echo ║              🔮 TokenSage - Starting Services                 ║
echo ╚═══════════════════════════════════════════════════════════════╝
echo.

cd /d "%~dp0"

:: Check if built
if not exist "dist\proxy.js" (
    echo [INFO] Project not built. Running setup first...
    call setup.bat
    if %ERRORLEVEL% NEQ 0 exit /b 1
)

:: Enable Windows System Proxy
echo [INFO] Enabling Windows System Proxy...
powershell -ExecutionPolicy Bypass -File "%~dp0proxy.ps1" on
echo.

:: Set environment
set PROXY_PORT=4000
set DASHBOARD_PORT=4001

echo [INFO] Starting TokenSage Proxy Server...
echo.
echo ───────────────────────────────────────────────────────────────
echo   Dashboard:  http://localhost:%DASHBOARD_PORT%
echo   Proxy:      http://localhost:%PROXY_PORT%
echo   Stats API:  http://localhost:%PROXY_PORT%/stats
echo ───────────────────────────────────────────────────────────────
echo.
echo   Configure your IDE:
echo   • Cursor/Windsurf: Settings ^> Models ^> Override OpenAI Base URL
echo   • Enter: http://localhost:%PROXY_PORT%/v1
echo.
echo   Or set environment variable:
echo   • set OPENAI_BASE_URL=http://localhost:%PROXY_PORT%/v1
echo ───────────────────────────────────────────────────────────────
echo.
echo   Press Ctrl+C to stop the server
echo.

:: Open dashboard in browser after 2 seconds
start /b cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:%DASHBOARD_PORT%"

:: Start proxy server
node dist/proxy.js

pause
