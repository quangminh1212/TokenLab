@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

echo.
echo ╔═══════════════════════════════════════════════════════════════╗
echo ║         🔮 TokenSage - Full AI Traffic Interceptor            ║
echo ╚═══════════════════════════════════════════════════════════════╝
echo.

cd /d "%~dp0"

:: ======================= RUN SETUP FIRST =======================
echo [INFO] Running setup to ensure all dependencies...
call setup.bat --silent
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Setup failed!
    pause
    exit /b 1
)

:: Set environment
set PROXY_PORT=4000
set DASHBOARD_PORT=4001

:: Set certificate for Node.js apps (Kiro, Cursor, etc.)
set CERT_PEM=%USERPROFILE%\.mitmproxy\mitmproxy-ca-cert.pem
if exist "%CERT_PEM%" (
    set NODE_EXTRA_CA_CERTS=%CERT_PEM%
    echo [INFO] NODE_EXTRA_CA_CERTS set for Node.js apps
)

:: ======================= FIND MITMWEB PATH =======================
echo.
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

:: Not found
echo [ERROR] Could not find mitmweb.
echo         Please ensure Python and mitmproxy are installed correctly.
pause
exit /b 1

:found_mitmweb
echo [INFO] Found: %MITMWEB_PATH%

echo.
echo ╔═══════════════════════════════════════════════════════════════╗
echo ║  Tracking ALL AI requests from 40+ providers:                 ║
echo ║  🌀 Antigravity   🔮 Cursor      🏄 Windsurf    🔷 Kiro       ║
echo ║  🐙 Copilot       🤖 OpenAI      🔶 Claude      ✨ Gemini     ║
echo ║  ☁️  AWS Bedrock   💎 Azure       ⚡ Groq        🔍 DeepSeek   ║
echo ╠═══════════════════════════════════════════════════════════════╣
echo ║  Endpoints:                                                   ║
echo ║  - Dashboard:  http://localhost:%DASHBOARD_PORT%                          ║
echo ║  - mitmweb:    http://127.0.0.1:8081                          ║
echo ║  - Proxy:      http://localhost:%PROXY_PORT%                           ║
echo ╚═══════════════════════════════════════════════════════════════╝
echo.

:: ======================= KILL OLD PROCESSES =======================
echo [INFO] Cleaning up old processes...
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":4000.*LISTENING"') do taskkill /F /PID %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":4001.*LISTENING"') do taskkill /F /PID %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":8080.*LISTENING"') do taskkill /F /PID %%a >nul 2>&1

:: ======================= START TOKENSAGE PROXY =======================
echo [INFO] Starting TokenSage proxy...
start /B cmd /c "node dist/proxy.js"
timeout /t 2 /nobreak >nul

:: ======================= OPEN DASHBOARDS =======================
echo [INFO] Opening dashboards...
start http://localhost:%DASHBOARD_PORT%
timeout /t 1 /nobreak >nul
start http://127.0.0.1:8081

echo.
echo ═══════════════════════════════════════════════════════════════
echo   mitmproxy running - Press Ctrl+C to stop
echo ═══════════════════════════════════════════════════════════════
echo.

:: ======================= START MITMPROXY =======================
"%MITMWEB_PATH%" --mode regular -p 8080 -s "%~dp0tokensage_addon.py" --set console_eventlog_verbosity=info

:: ======================= CLEANUP =======================
echo.
echo [INFO] Shutting down...
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":4000.*LISTENING"') do taskkill /F /PID %%a >nul 2>&1

pause
