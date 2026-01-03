@echo off
chcp 65001 >nul
echo.
echo ╔═══════════════════════════════════════════════════════════════╗
echo ║     🔮 TokenSage - System-Wide Traffic Interceptor            ║
echo ╠═══════════════════════════════════════════════════════════════╣
echo ║  This will intercept ALL LLM API traffic including:           ║
echo ║  - Cursor AI (api2.cursor.sh)                                 ║
echo ║  - Google Gemini (generativelanguage.googleapis.com)          ║
echo ║  - OpenAI, Anthropic, Mistral, and more                       ║
echo ║                                                               ║
echo ║  Data will be sent to TokenSage for storage and dashboard     ║
echo ╚═══════════════════════════════════════════════════════════════╝
echo.

:: Check if mitmproxy is installed
where mitmweb >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [INFO] mitmproxy not found. Installing...
    pip install mitmproxy
    if %ERRORLEVEL% NEQ 0 (
        echo [ERROR] Failed to install mitmproxy. Please install Python first.
        pause
        exit /b 1
    )
)

:: Check if TokenSage proxy is running
echo [INFO] Checking TokenSage proxy...
curl -s http://localhost:4000/health >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [WARN] TokenSage proxy not running at localhost:4000
    echo [INFO] Starting TokenSage proxy in background...
    start /B cmd /c "npm run proxy"
    timeout /t 3 /nobreak >nul
)

echo.
echo ╔═══════════════════════════════════════════════════════════════╗
echo ║  FIRST-TIME SETUP (if not done before):                       ║
echo ║                                                               ║
echo ║  1. After mitmproxy starts, open: http://mitm.it              ║
echo ║  2. Download and install the Windows certificate              ║
echo ║  3. Install to "Trusted Root Certification Authorities"       ║
echo ║                                                               ║
echo ║  Configure Windows Proxy:                                     ║
echo ║  Settings ^> Network ^> Proxy ^> Manual Setup                  ║
echo ║  Address: 127.0.0.1   Port: 8080                              ║
echo ║                                                               ║
echo ║  OR run this command (Admin required):                        ║
echo ║  netsh winhttp set proxy 127.0.0.1:8080                       ║
echo ╚═══════════════════════════════════════════════════════════════╝
echo.
echo [INFO] mitmweb interface: http://127.0.0.1:8081
echo [INFO] TokenSage dashboard: http://localhost:4001
echo [INFO] Press Ctrl+C to stop
echo.

:: Open dashboards
timeout /t 2 /nobreak >nul
start http://127.0.0.1:8081
start http://localhost:4001

:: Run mitmproxy with TokenSage addon
mitmweb --mode regular -p 8080 -s "%~dp0tokensage_addon.py" --set console_eventlog_verbosity=info

pause
