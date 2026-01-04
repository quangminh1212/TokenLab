@echo off
chcp 65001 >nul

echo.
echo ╔═══════════════════════════════════════════════════════════════╗
echo ║     🛑 TokenSage - Quick Stop                                 ║
echo ╚═══════════════════════════════════════════════════════════════╝
echo.

cd /d "%~dp0"

:: Disable Windows System Proxy
echo [INFO] Disabling Windows System Proxy...
powershell -ExecutionPolicy Bypass -File "%~dp0proxy.ps1" off

:: Kill mitmproxy processes
echo.
echo [INFO] Stopping mitmproxy processes...
taskkill /F /IM mitmweb.exe >nul 2>&1
taskkill /F /IM mitmdump.exe >nul 2>&1
taskkill /F /IM mitmproxy.exe >nul 2>&1
echo [OK] Mitmproxy processes stopped

:: Kill any node processes running proxy (optional)
echo.
echo [INFO] Stopping TokenSage proxy processes...
for /f "tokens=2" %%a in ('netstat -ano ^| findstr :4000 ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>&1
)
echo [OK] TokenSage processes stopped

echo.
echo ╔═══════════════════════════════════════════════════════════════╗
echo ║  ✅ Windows Proxy: DISABLED                                   ║
echo ║  ✅ Mitmproxy: STOPPED                                        ║
echo ║  ✅ TokenSage: STOPPED                                        ║
echo ║                                                               ║
echo ║  Your network is back to normal!                              ║
echo ╚═══════════════════════════════════════════════════════════════╝
echo.

pause
