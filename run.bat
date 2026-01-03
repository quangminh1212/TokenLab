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

:: ======================= FIND MITMWEB PATH =======================
echo [INFO] Locating mitmproxy...
set MITMWEB_PATH=

:: Try common locations
for %%P in (
    "%APPDATA%\Python\Python314\Scripts\mitmweb.exe"
    "%APPDATA%\Python\Python313\Scripts\mitmweb.exe"
    "%APPDATA%\Python\Python312\Scripts\mitmweb.exe"
    "%APPDATA%\Python\Python311\Scripts\mitmweb.exe"
    "%LOCALAPPDATA%\Programs\Python\Python314\Scripts\mitmweb.exe"
    "%LOCALAPPDATA%\Programs\Python\Python313\Scripts\mitmweb.exe"
    "%LOCALAPPDATA%\Programs\Python\Python312\Scripts\mitmweb.exe"
    "%LOCALAPPDATA%\Programs\Python\Python311\Scripts\mitmweb.exe"
    "C:\Python314\Scripts\mitmweb.exe"
    "C:\Python313\Scripts\mitmweb.exe"
    "C:\Python312\Scripts\mitmweb.exe"
) do (
    if exist "%%~P" (
        set "MITMWEB_PATH=%%~P"
        goto :found_mitmweb
    )
)

:: Try where command
for /f "tokens=*" %%i in ('where mitmweb 2^>nul') do (
    set "MITMWEB_PATH=%%i"
    goto :found_mitmweb
)

:: Try pip show to find location
for /f "tokens=2 delims=: " %%i in ('pip show mitmproxy 2^>nul ^| findstr /i "Location"') do (
    set "PIP_LOC=%%i"
    if exist "!PIP_LOC!\..\Scripts\mitmweb.exe" (
        set "MITMWEB_PATH=!PIP_LOC!\..\Scripts\mitmweb.exe"
        goto :found_mitmweb
    )
)

:: Not found - try to install
echo [WARN] mitmproxy not found. Installing...
pip install mitmproxy --quiet
for /f "tokens=*" %%i in ('where mitmweb 2^>nul') do (
    set "MITMWEB_PATH=%%i"
    goto :found_mitmweb
)

:: Still not found
echo [ERROR] Could not find mitmweb after installation.
echo         Please add Python Scripts folder to PATH and restart.
echo         Or run: pip install mitmproxy
pause
exit /b 1

:found_mitmweb
echo [INFO] Found mitmproxy: %MITMWEB_PATH%

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
echo ╠═══════════════════════════════════════════════════════════════╣
echo ║  Endpoints:                                                   ║
echo ║  - TokenSage Dashboard: http://localhost:%DASHBOARD_PORT%                 ║
echo ║  - mitmweb Interface:   http://127.0.0.1:8081                 ║
echo ║  - Proxy Server:        http://localhost:%PROXY_PORT%                  ║
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
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":4000.*LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":4001.*LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":8080.*LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)

:: ======================= START TOKENSAGE PROXY =======================
echo [INFO] Starting TokenSage proxy server...
start /B cmd /c "node dist/proxy.js"
timeout /t 2 /nobreak >nul

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
start http://127.0.0.1:8081

:: Run mitmproxy with TokenSage addon
"%MITMWEB_PATH%" --mode regular -p 8080 -s "%~dp0tokensage_addon.py" --set console_eventlog_verbosity=info

:: ======================= CLEANUP ON EXIT =======================
echo.
echo [INFO] Shutting down TokenSage...
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":4000.*LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)

pause
