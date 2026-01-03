@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

echo.
echo ╔═══════════════════════════════════════════════════════════════╗
echo ║         🔮 TokenSage - Full AI Traffic Interceptor            ║
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

:: ======================= CHECK MITMPROXY =======================
echo [INFO] Checking mitmproxy...
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
    echo [INFO] mitmproxy installed successfully!
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
echo ║  🧠 JetBrains     ⚡ Zed         🎯 Tabnine     🤗 HuggingFace║
echo ║  And 30+ more providers...                                    ║
echo ║                                                               ║
echo ╠═══════════════════════════════════════════════════════════════╣
echo ║  Endpoints:                                                   ║
echo ║  - TokenSage Dashboard: http://localhost:%DASHBOARD_PORT%                 ║
echo ║  - mitmweb Interface:   http://127.0.0.1:8081                 ║
echo ║  - Proxy Server:        http://localhost:%PROXY_PORT%                  ║
echo ║  - Settings API:        http://localhost:%PROXY_PORT%/settings          ║
echo ╚═══════════════════════════════════════════════════════════════╝
echo.
echo ╔═══════════════════════════════════════════════════════════════╗
echo ║  FIRST TIME SETUP (one-time only):                            ║
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

:: ======================= KILL OLD PROCESSES =======================
echo [INFO] Cleaning up old processes...
taskkill /F /IM "node.exe" /FI "WINDOWTITLE eq *proxy*" >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :4000 ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>&1
)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :4001 ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>&1
)

:: ======================= START TOKENSAGE PROXY =======================
echo [INFO] Starting TokenSage proxy server...
start /B cmd /c "node dist/proxy.js"
timeout /t 2 /nobreak >nul

:: ======================= VERIFY TOKENSAGE IS RUNNING =======================
curl -s http://localhost:%PROXY_PORT%/health >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [WARN] TokenSage proxy may not have started properly.
    echo        Waiting 3 more seconds...
    timeout /t 3 /nobreak >nul
)

:: ======================= OPEN DASHBOARDS =======================
echo [INFO] Opening dashboards...
start http://localhost:%DASHBOARD_PORT%
timeout /t 1 /nobreak >nul

echo.
echo ───────────────────────────────────────────────────────────────
echo [INFO] Starting mitmproxy interceptor...
echo [INFO] Press Ctrl+C to stop all services
echo ───────────────────────────────────────────────────────────────
echo.

:: ======================= START MITMPROXY =======================
:: Open mitmweb interface
start http://127.0.0.1:8081

:: Run mitmproxy with TokenSage addon
mitmweb --mode regular -p 8080 -s "%~dp0tokensage_addon.py" --set console_eventlog_verbosity=info

:: ======================= CLEANUP ON EXIT =======================
echo.
echo [INFO] Shutting down TokenSage...
taskkill /F /IM "node.exe" >nul 2>&1

pause
