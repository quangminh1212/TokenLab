@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

echo.
echo ╔═══════════════════════════════════════════════════════════════╗
echo ║              🔮 TokenSage - AI Usage Tracker                  ║
echo ║              Track ALL AI requests automatically              ║
echo ╚═══════════════════════════════════════════════════════════════╝
echo.

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
    :: Enable Windows system proxy
    echo [INFO] Enabling Windows system proxy...
    reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f >nul
    reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyServer /t REG_SZ /d "127.0.0.1:8080" /f >nul
    
    echo.
    echo ───────────────────────────────────────────────────────────────
    echo   ✅ FULL TRACKING MODE (mitmproxy)
    echo   Dashboard:  http://localhost:4001
    echo   Proxy:      127.0.0.1:8080
    echo ───────────────────────────────────────────────────────────────
    echo.
    echo   ⚠️  First time? Install certificate:
    echo   1. Open browser: http://mitm.it
    echo   2. Download and install Windows certificate
    echo ───────────────────────────────────────────────────────────────
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
)

echo.
echo   Press Ctrl+C to stop
echo.

:: Open dashboard
start "" "http://localhost:4001"

if "%USE_MITM%"=="1" (
    :: Start mitmproxy
    "%MITMDUMP%" -s addon.py --set block_global=false
    
    :: Cleanup when stopped
    echo.
    echo [INFO] Disabling Windows system proxy...
    reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f >nul
    taskkill /f /im node.exe >nul 2>&1
    echo [INFO] Done.
) else (
    :: Just run node server in foreground
    echo [INFO] Running in manual proxy mode...
    echo        Press Ctrl+C to stop
    pause >nul
    taskkill /f /im node.exe >nul 2>&1
)
