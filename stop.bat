@echo off
chcp 65001 >nul

echo.
echo ╔═══════════════════════════════════════════════════════════════╗
echo ║  🔮 TokenSage - Stop and Cleanup                              ║
echo ╚═══════════════════════════════════════════════════════════════╝
echo.

:: Disable system proxy
echo [INFO] Disabling system proxy...
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f >nul 2>&1
echo [OK] System proxy disabled

:: Kill TokenSage processes
echo [INFO] Stopping TokenSage processes...
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":4000.*LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
    echo [OK] Stopped process on port 4000
)
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":4001.*LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
    echo [OK] Stopped process on port 4001
)
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":8080.*LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
    echo [OK] Stopped mitmproxy on port 8080
)
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":8081.*LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
    echo [OK] Stopped mitmweb UI on port 8081
)

:: Kill any remaining mitmproxy/mitmweb processes
taskkill /F /IM mitmproxy.exe >nul 2>&1
taskkill /F /IM mitmweb.exe >nul 2>&1
taskkill /F /IM mitmdump.exe >nul 2>&1

echo.
echo [OK] TokenSage stopped completely!
echo [INFO] Your internet connection should now work normally.
echo.
pause
