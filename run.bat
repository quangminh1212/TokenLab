@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

echo.
echo ╔═══════════════════════════════════════════════════════════════╗
echo ║        🔮 TokenSage - Safe Mode (No System Proxy)             ║
echo ║        Only tracks apps configured to use this proxy          ║
echo ╚═══════════════════════════════════════════════════════════════╝
echo.

cd /d "%~dp0"

:: Check if built
if not exist "dist\proxy.js" (
    echo [INFO] Project not built. Running setup first...
    call setup.bat
    if %ERRORLEVEL% NEQ 0 exit /b 1
)

:: IMPORTANT: Do NOT enable Windows System Proxy
:: This keeps other apps working normally
echo [INFO] Safe Mode: Windows System Proxy will NOT be changed
echo [INFO] Only apps configured to use localhost:4000 will be tracked
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
echo   ⚠️  SAFE MODE - Other apps will NOT be affected!
echo.
echo   Configure ONLY your AI IDE:
echo   • Cursor: Settings ^> Models ^> Override OpenAI Base URL
echo     Enter: http://localhost:%PROXY_PORT%/v1
echo.
echo   • Windsurf: Settings ^> API Configuration ^> Base URL
echo     Enter: http://localhost:%PROXY_PORT%/v1
echo.
echo   • Or start IDE with env var:
echo     set OPENAI_BASE_URL=http://localhost:%PROXY_PORT%/v1
echo ───────────────────────────────────────────────────────────────
echo.
echo   Press Ctrl+C to stop the server
echo.

:: Open dashboard in browser after 2 seconds
start /b cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:%DASHBOARD_PORT%"

:: Start proxy server
node dist/proxy.js

pause
