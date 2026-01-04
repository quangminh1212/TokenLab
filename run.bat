@echo off
:: Check for admin rights and self-elevate if needed
net session >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [INFO] Requesting Administrator privileges...
    powershell -NoProfile -Command "Start-Process cmd -ArgumentList '/c \"%~f0\"' -Verb RunAs"
    exit /b
)

chcp 65001 >nul
setlocal EnableDelayedExpansion

echo.
echo ╔═══════════════════════════════════════════════════════════════╗
echo ║              🔮 TokenSage - AI Usage Tracker                  ║
echo ║              Track ALL AI requests automatically              ║
echo ╚═══════════════════════════════════════════════════════════════╝
echo.

:: ═══════════════════════════════════════════════════════════════════
:: Disable conflicting services that cause network issues
:: ═══════════════════════════════════════════════════════════════════
echo [INFO] Checking for conflicting services...

:: Stop Cloudflare WARP (causes QUIC conflicts)
tasklist /fi "imagename eq Cloudflare WARP.exe" 2>nul | find /i "Cloudflare WARP.exe" >nul
if %ERRORLEVEL%==0 (
    echo [INFO] Stopping Cloudflare WARP...
    taskkill /f /im "Cloudflare WARP.exe" >nul 2>&1
    net stop CloudflareWARP >nul 2>&1
)

:: Stop other VPN/proxy services that may conflict
net stop "WireGuard" >nul 2>&1
net stop "OpenVPNService" >nul 2>&1

cd /d "%~dp0"

:: Check Node.js
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js not found! Please install Node.js 18+
    pause
    exit /b 1
)

:: Find mitmdump
set MITMDUMP=
where mitmdump >nul 2>&1 && set MITMDUMP=mitmdump
if "%MITMDUMP%"=="" (
    for %%V in (314 313 312 311 310) do (
        if exist "%USERPROFILE%\AppData\Roaming\Python\Python%%V\Scripts\mitmdump.exe" (
            set MITMDUMP=%USERPROFILE%\AppData\Roaming\Python\Python%%V\Scripts\mitmdump.exe
            goto :found_mitm
        )
        if exist "%USERPROFILE%\AppData\Local\Programs\Python\Python%%V\Scripts\mitmdump.exe" (
            set MITMDUMP=%USERPROFILE%\AppData\Local\Programs\Python\Python%%V\Scripts\mitmdump.exe
            goto :found_mitm
        )
    )
)
:found_mitm

if "%MITMDUMP%"=="" (
    echo [WARN] mitmproxy not found - running in manual proxy mode only
    echo        To track ALL requests, install: pip install mitmproxy
    echo.
    set USE_MITM=0
) else (
    echo [INFO] Found mitmproxy: %MITMDUMP%
    set USE_MITM=1
)

:: Check if built
if not exist "dist\proxy.js" (
    echo [INFO] Building project...
    call npm run build
    if %ERRORLEVEL% NEQ 0 (
        echo [ERROR] Build failed!
        pause
        exit /b 1
    )
)

:: Start TokenSage server
echo [INFO] Starting TokenSage server...
start /b cmd /c "node dist/proxy.js"
timeout /t 2 /nobreak >nul

if "%USE_MITM%"=="1" (
    echo.
    echo ───────────────────────────────────────────────────────────────
    echo   ✅ TRANSPARENT PROXY MODE (WinDivert)
    echo   Dashboard:  http://localhost:4001
    echo   Intercepts ALL local traffic automatically!
    echo ───────────────────────────────────────────────────────────────
    echo.
    echo   ⚠️  First time? Install certificate:
    echo   1. Open browser: http://mitm.it
    echo   2. Download and install Windows certificate
    echo ───────────────────────────────────────────────────────────────
    echo.
    echo   Press Ctrl+C to stop
    echo.
    
    :: Open dashboard
    start "" "http://localhost:4001"
    
    :: Start mitmproxy in LOCAL mode with FILTERED traffic
    :: ONLY intercept AI API hosts - ignore everything else to prevent network issues
    "%MITMDUMP%" --mode "local:!443@127.0.0.1" -s addon.py --set block_global=false --allow-hosts "api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|aiplatform\.googleapis\.com|bedrock.*\.amazonaws\.com|api\.deepseek\.com|api\.mistral\.ai|api\.groq\.com|api\.together\.xyz|api\.perplexity\.ai|api\.cohere\.ai|api\.replicate\.com|api-inference\.huggingface\.co|api\.fireworks\.ai|kiro\.dev|35\.174\.34\."
    
    :: Cleanup when stopped
    echo.
    echo [INFO] Stopping...
    taskkill /f /im node.exe >nul 2>&1
    echo [INFO] Done.
) else (
    echo.
    echo ───────────────────────────────────────────────────────────────
    echo   Dashboard:  http://localhost:4001
    echo   Proxy:      http://localhost:4000
    echo ───────────────────────────────────────────────────────────────
    echo.
    echo   Configure your AI IDE to use the proxy:
    echo   OPENAI_BASE_URL=http://localhost:4000/v1
    echo ───────────────────────────────────────────────────────────────
    
    :: Open dashboard
    start "" "http://localhost:4001"
    
    echo.
    echo   Press any key to stop...
    pause >nul
    taskkill /f /im node.exe >nul 2>&1
)
