@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

echo.
echo ╔═══════════════════════════════════════════════════════════════╗
echo ║              🔮 TokenSage - AI Usage Tracker                  ║
echo ╚═══════════════════════════════════════════════════════════════╝
echo.

cd /d "%~dp0"

:: Check if built
if not exist "dist\proxy.js" (
    echo [INFO] Project not built. Running setup first...
    call setup.bat
    if %ERRORLEVEL% NEQ 0 exit /b 1
)

:: Set environment
set PROXY_PORT=4000
set DASHBOARD_PORT=4001

echo.
echo ───────────────────────────────────────────────────────────────
echo   Select Mode:
echo ───────────────────────────────────────────────────────────────
echo.
echo   [1] Basic Mode (Proxy Server Only)
echo       - Direct proxy for apps that support custom API URLs
echo       - Dashboard: http://localhost:%DASHBOARD_PORT%
echo.
echo   [2] Full Mode (Proxy + mitmproxy Interceptor)
echo       - Intercept ALL AI traffic system-wide
echo       - Track: Antigravity, Cursor, Kiro, Windsurf, Copilot...
echo       - Requires mitmproxy certificate installation
echo.
echo   [3] Dashboard Only (View existing data)
echo       - Just open the dashboard in browser
echo.
echo ───────────────────────────────────────────────────────────────
echo.

set /p MODE="Enter choice [1/2/3] (default=1): "
if "%MODE%"=="" set MODE=1

if "%MODE%"=="3" (
    echo [INFO] Opening dashboard...
    start http://localhost:%DASHBOARD_PORT%
    exit /b 0
)

if "%MODE%"=="2" (
    goto :FULL_MODE
)

:BASIC_MODE
echo.
echo [INFO] Starting TokenSage in Basic Mode...
echo.
echo ╔═══════════════════════════════════════════════════════════════╗
echo ║  Basic Mode - Proxy Server                                    ║
echo ╠═══════════════════════════════════════════════════════════════╣
echo ║  Dashboard:   http://localhost:%DASHBOARD_PORT%                            ║
echo ║  Proxy:       http://localhost:%PROXY_PORT%                             ║
echo ║  Stats API:   http://localhost:%PROXY_PORT%/stats                       ║
echo ║  Settings:    http://localhost:%PROXY_PORT%/settings                    ║
echo ╠═══════════════════════════════════════════════════════════════╣
echo ║  Configure your IDE:                                          ║
echo ║  - Cursor/Windsurf: Settings ^> Models ^> Override Base URL   ║
echo ║  - Enter: http://localhost:%PROXY_PORT%/v1                              ║
echo ║  - Or set: OPENAI_BASE_URL=http://localhost:%PROXY_PORT%/v1             ║
echo ╚═══════════════════════════════════════════════════════════════╝
echo.
echo   Press Ctrl+C to stop the server
echo.

:: Open dashboard in browser after 2 seconds
start /b cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:%DASHBOARD_PORT%"

:: Start proxy server
node dist/proxy.js
goto :END

:FULL_MODE
echo.
echo [INFO] Starting TokenSage in Full Mode (with mitmproxy)...
echo.

:: Check if mitmproxy is installed
where mitmweb >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [WARN] mitmproxy not found. Installing...
    pip install mitmproxy
    if %ERRORLEVEL% NEQ 0 (
        echo [ERROR] Failed to install mitmproxy. 
        echo         Please install Python first from https://python.org/
        pause
        exit /b 1
    )
)

echo.
echo ╔═══════════════════════════════════════════════════════════════╗
echo ║  Full Mode - System-Wide AI Traffic Interceptor               ║
echo ╠═══════════════════════════════════════════════════════════════╣
echo ║                                                               ║
echo ║  Tracking ALL AI requests from:                               ║
echo ║  🌀 Antigravity   🔮 Cursor      🏄 Windsurf    🔷 Kiro       ║
echo ║  🐙 Copilot       🤖 OpenAI      🔶 Claude      ✨ Gemini     ║
echo ║  ☁️  AWS Bedrock   💎 Azure       ⚡ Groq        🔍 DeepSeek   ║
echo ║  And 30+ more providers...                                    ║
echo ║                                                               ║
echo ╠═══════════════════════════════════════════════════════════════╣
echo ║  Endpoints:                                                   ║
echo ║  - TokenSage Dashboard: http://localhost:%DASHBOARD_PORT%                 ║
echo ║  - mitmweb Interface:   http://127.0.0.1:8081                 ║
echo ║  - Proxy Server:        http://localhost:%PROXY_PORT%                  ║
echo ╚═══════════════════════════════════════════════════════════════╝
echo.
echo ╔═══════════════════════════════════════════════════════════════╗
echo ║  IMPORTANT SETUP (First time only):                           ║
echo ║                                                               ║
echo ║  1. Install mitmproxy CA certificate:                         ║
echo ║     - Open http://mitm.it after mitmproxy starts              ║
echo ║     - Download Windows certificate                            ║
echo ║     - Install to "Trusted Root Certification Authorities"     ║
echo ║                                                               ║
echo ║  2. Configure System Proxy:                                   ║
echo ║     Settings ^> Network ^> Proxy ^> Manual Setup               ║
echo ║     Address: 127.0.0.1   Port: 8080                           ║
echo ╚═══════════════════════════════════════════════════════════════╝
echo.
echo [INFO] Press Ctrl+C to stop all services
echo.

:: Start TokenSage proxy in background
echo [INFO] Starting TokenSage proxy server...
start /B cmd /c "node dist/proxy.js"
timeout /t 2 /nobreak >nul

:: Open dashboards
start http://localhost:%DASHBOARD_PORT%
timeout /t 1 /nobreak >nul
start http://127.0.0.1:8081

:: Run mitmproxy with TokenSage addon
echo [INFO] Starting mitmproxy interceptor...
mitmweb --mode regular -p 8080 -s "%~dp0tokensage_addon.py" --set console_eventlog_verbosity=info

:END
pause
