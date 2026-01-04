@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

echo.
echo ╔═══════════════════════════════════════════════════════════════╗
echo ║     🔮 TokenSage - Full Interceptor Mode                      ║
echo ║     Intercepts ALL AI traffic system-wide                     ║
echo ╚═══════════════════════════════════════════════════════════════╝
echo.

cd /d "%~dp0"

:: Check if mitmweb exists
where mitmweb >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [INFO] Looking for mitmweb in Python user scripts...
    set "MITMWEB=%APPDATA%\Python\Python314\Scripts\mitmweb.exe"
    if not exist "!MITMWEB!" (
        set "MITMWEB=%APPDATA%\Python\Python312\Scripts\mitmweb.exe"
    )
    if not exist "!MITMWEB!" (
        echo [ERROR] mitmweb not found. Installing...
        pip install mitmproxy
        set "MITMWEB=mitmweb"
    )
) else (
    set "MITMWEB=mitmweb"
)

:: Check if TokenSage proxy is running
echo [INFO] Checking TokenSage proxy...
curl -s http://localhost:4000/health >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [INFO] Starting TokenSage proxy in background...
    start /B cmd /c "cd /d %~dp0 && npm run proxy"
    timeout /t 3 /nobreak >nul
)

:: Enable Windows System Proxy
echo.
echo [INFO] Enabling Windows System Proxy...
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f >nul
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyServer /t REG_SZ /d "127.0.0.1:8080" /f >nul
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyOverride /t REG_SZ /d "localhost;127.*;10.*;192.168.*;*.local" /f >nul
echo [OK] Windows Proxy ENABLED: 127.0.0.1:8080
echo [OK] Bypass: localhost, 127.*, 10.*, 192.168.*, *.local

echo.
echo ╔═══════════════════════════════════════════════════════════════╗
echo ║  ✅ System Proxy: 127.0.0.1:8080                              ║
echo ║  ✅ Mitmproxy Web: http://127.0.0.1:8081                      ║
echo ║  ✅ TokenSage Dashboard: http://localhost:4001                ║
echo ║                                                               ║
echo ║  All AI traffic will now be intercepted!                      ║
echo ║  Press Ctrl+C to stop, then run stop.bat                      ║
echo ╚═══════════════════════════════════════════════════════════════╝
echo.

:: Open dashboards
timeout /t 2 /nobreak >nul
start http://127.0.0.1:8081
start http://localhost:4001

:: Run mitmproxy with TokenSage addon
"!MITMWEB!" --mode regular -p 8080 -s "%~dp0addon.py" --web-port 8081 --set console_eventlog_verbosity=info

:: When mitmproxy exits, disable proxy
echo.
echo [INFO] Mitmproxy stopped. Disabling Windows Proxy...
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f >nul
echo [OK] Windows Proxy DISABLED

pause
