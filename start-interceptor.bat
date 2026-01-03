@echo off
chcp 65001 >nul
echo.
echo ╔═══════════════════════════════════════════════════════════════╗
echo ║     🔮 TokenSage - System-Wide Traffic Interceptor            ║
echo ╠═══════════════════════════════════════════════════════════════╣
echo ║  This will intercept ALL LLM API traffic including:           ║
echo ║  - Cursor AI, Kiro, Windsurf                                  ║
echo ║  - OpenAI, Anthropic, Google Gemini                           ║
echo ║  - Amazon Bedrock, Azure OpenAI, and more                     ║
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
    start /B cmd /c "cd /d %~dp0 && npm run proxy"
    timeout /t 3 /nobreak >nul
)

echo.
echo ╔═══════════════════════════════════════════════════════════════╗
echo ║  IMPORTANT SETUP STEPS:                                       ║
echo ║                                                               ║
echo ║  1. Install mitmproxy CA certificate:                         ║
echo ║     - Open http://mitm.it after mitmproxy starts              ║
echo ║     - Download Windows certificate                            ║
echo ║     - Install to "Trusted Root Certification Authorities"     ║
echo ║                                                               ║
echo ║  2. Configure System Proxy (choose one):                      ║
echo ║                                                               ║
echo ║     Option A - Windows Settings:                              ║
echo ║     Settings ^> Network ^> Proxy ^> Manual Setup               ║
echo ║     Address: 127.0.0.1   Port: 8080                           ║
echo ║                                                               ║
echo ║     Option B - Environment Variable (for specific apps):      ║
echo ║     set HTTPS_PROXY=http://127.0.0.1:8080                     ║
echo ║     set HTTP_PROXY=http://127.0.0.1:8080                      ║
echo ║                                                               ║
echo ║  NOTE: Some apps like Kiro may use their own certificates     ║
echo ║  and bypass system proxy. Use TokenSage proxy directly for    ║
echo ║  those apps by setting OPENAI_BASE_URL.                       ║
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
