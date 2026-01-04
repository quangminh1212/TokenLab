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
set MITM_PORT=8080

:: Set certificate for Node.js apps (Kiro, Cursor, etc.)
set CERT_PEM=%USERPROFILE%\.mitmproxy\mitmproxy-ca-cert.pem
if exist "%CERT_PEM%" (
    set NODE_EXTRA_CA_CERTS=%CERT_PEM%
    echo [INFO] NODE_EXTRA_CA_CERTS set for Node.js apps
)

:: ======================= SET ENVIRONMENT PROXY =======================
echo [INFO] Setting proxy environment variables...
set HTTP_PROXY=http://localhost:%MITM_PORT%
set HTTPS_PROXY=http://localhost:%MITM_PORT%
set http_proxy=http://localhost:%MITM_PORT%
set https_proxy=http://localhost:%MITM_PORT%
set NO_PROXY=localhost,127.0.0.1

:: ======================= TRY TO SET SYSTEM PROXY =======================
echo [INFO] Attempting to set system proxy (requires Admin for WinHTTP)...

:: Set Internet Explorer/Windows proxy settings (usually works without admin)
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f >nul 2>&1
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyServer /t REG_SZ /d "localhost:%MITM_PORT%" /f >nul 2>&1
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyOverride /t REG_SZ /d "localhost;127.0.0.1;<local>" /f >nul 2>&1

if %ERRORLEVEL% EQU 0 (
    echo [OK] System proxy configured: localhost:%MITM_PORT%
) else (
    echo [WARN] Could not set system proxy. Some apps may need manual configuration.
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
echo ║  - Proxy:      http://localhost:%MITM_PORT% (mitmproxy)              ║
echo ║  - API:        http://localhost:%PROXY_PORT% (TokenSage)             ║
echo ╠═══════════════════════════════════════════════════════════════╣
echo ║  System Proxy: ENABLED (localhost:%MITM_PORT%)                       ║
echo ║  All HTTP/HTTPS traffic will be intercepted automatically    ║
echo ╚═══════════════════════════════════════════════════════════════╝
echo.

:: ======================= KILL OLD PROCESSES =======================
echo [INFO] Cleaning up old processes...
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":4000.*LISTENING"') do taskkill /F /PID %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":4001.*LISTENING"') do taskkill /F /PID %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":8080.*LISTENING"') do taskkill /F /PID %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":8081.*LISTENING"') do taskkill /F /PID %%a >nul 2>&1

:: ======================= START TOKENSAGE PROXY =======================
echo [INFO] Starting TokenSage proxy on port %PROXY_PORT%...
start /B cmd /c "node dist/proxy.js"
timeout /t 2 /nobreak >nul

:: Verify TokenSage is running
curl -s http://localhost:%PROXY_PORT%/health >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo [OK] TokenSage proxy is running
) else (
    echo [WARN] TokenSage proxy may not be ready yet
)

:: ======================= OPEN DASHBOARDS =======================
echo [INFO] Opening dashboards...
start http://localhost:%DASHBOARD_PORT%
timeout /t 1 /nobreak >nul
start http://127.0.0.1:8081

echo.
echo ═══════════════════════════════════════════════════════════════
echo   🔮 TokenSage is ACTIVE - Intercepting all AI traffic
echo   
echo   📝 To track AI IDE requests:
echo      - All apps using system proxy will be tracked automatically
echo      - For apps that bypass proxy, use: run-with-proxy.bat [app]
echo   
echo   Press Ctrl+C to stop and disable proxy
echo ═══════════════════════════════════════════════════════════════
echo.

:: ======================= START MITMPROXY =======================
"%MITMWEB_PATH%" --mode regular -p %MITM_PORT% -s "%~dp0tokensage_addon.py" --set console_eventlog_verbosity=info --no-web-open-browser

:: ======================= CLEANUP =======================
echo.
echo [INFO] Shutting down and restoring proxy settings...

:: Disable system proxy
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f >nul 2>&1
echo [OK] System proxy disabled

:: Kill processes
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":4000.*LISTENING"') do taskkill /F /PID %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":8080.*LISTENING"') do taskkill /F /PID %%a >nul 2>&1

echo [INFO] TokenSage stopped. Goodbye!
pause
