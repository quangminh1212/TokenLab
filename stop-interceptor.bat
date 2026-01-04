@echo off
chcp 65001 >nul

echo.
echo ╔═══════════════════════════════════════════════════════════════╗
echo ║     🛑 TokenSage - Stop Interceptor                           ║
echo ╚═══════════════════════════════════════════════════════════════╝
echo.

:: Disable Windows System Proxy
echo [INFO] Disabling Windows System Proxy...
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f >nul
echo [OK] Windows Proxy DISABLED

:: Kill mitmproxy processes
echo.
echo [INFO] Stopping mitmproxy processes...
taskkill /F /IM mitmweb.exe >nul 2>&1
taskkill /F /IM mitmdump.exe >nul 2>&1
taskkill /F /IM mitmproxy.exe >nul 2>&1
echo [OK] Mitmproxy processes stopped

:: Optional: Stop TokenSage proxy (uncomment if needed)
:: echo.
:: echo [INFO] Stopping TokenSage proxy...
:: taskkill /F /FI "WINDOWTITLE eq node*" >nul 2>&1

echo.
echo ╔═══════════════════════════════════════════════════════════════╗
echo ║  ✅ Windows Proxy: DISABLED                                   ║
echo ║  ✅ Mitmproxy: STOPPED                                        ║
echo ║                                                               ║
echo ║  Your network is back to normal!                              ║
echo ╚═══════════════════════════════════════════════════════════════╝
echo.

pause
