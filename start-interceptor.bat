@echo off
chcp 65001 >nul
echo.
echo ╔═══════════════════════════════════════════════════════════════╗
echo ║     🔮 TokenSage - System-Wide Traffic Interceptor           ║
echo ╠═══════════════════════════════════════════════════════════════╣
echo ║  This will intercept ALL LLM API traffic including:          ║
echo ║  - Cursor AI (api2.cursor.sh)                                ║
echo ║  - Antigravity/Gemini (generativelanguage.googleapis.com)    ║
echo ║  - OpenAI, Anthropic, and more                               ║
echo ╚═══════════════════════════════════════════════════════════════╝
echo.

:: Check if mitmproxy is installed
where mitmweb >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] mitmproxy not found. Installing...
    pip install mitmproxy
)

echo [INFO] Starting mitmproxy with TokenSage addon...
echo.
echo ╔═══════════════════════════════════════════════════════════════╗
echo ║  IMPORTANT: First-time setup required!                       ║
echo ║                                                               ║
echo ║  1. After mitmproxy starts, open browser to: http://mitm.it  ║
echo ║  2. Download and install the Windows certificate             ║
echo ║  3. Install to "Trusted Root Certification Authorities"      ║
echo ║                                                               ║
echo ║  Then configure Windows Proxy:                                ║
echo ║  Settings ^> Network ^> Proxy ^> Manual Setup                  ║
echo ║  Address: 127.0.0.1   Port: 8080                              ║
echo ╚═══════════════════════════════════════════════════════════════╝
echo.
echo [INFO] mitmweb interface will open at http://127.0.0.1:8081
echo [INFO] Press Ctrl+C to stop
echo.

:: Run mitmproxy with TokenSage addon
mitmweb --mode regular -p 8080 -s "%~dp0tokensage_addon.py" --set console_eventlog_verbosity=info

pause
