@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

:: ======================= RUN APP WITH PROXY =======================
:: This script launches an application with proxy environment variables set
:: Usage: run-with-proxy.bat [app-name or path]
:: Examples:
::   run-with-proxy.bat cursor
::   run-with-proxy.bat windsurf
::   run-with-proxy.bat code
::   run-with-proxy.bat "C:\Path\To\App.exe"

cd /d "%~dp0"

set MITM_PORT=8080
set CERT_PEM=%USERPROFILE%\.mitmproxy\mitmproxy-ca-cert.pem

:: Set proxy environment variables
set HTTP_PROXY=http://localhost:%MITM_PORT%
set HTTPS_PROXY=http://localhost:%MITM_PORT%
set http_proxy=http://localhost:%MITM_PORT%
set https_proxy=http://localhost:%MITM_PORT%
set ALL_PROXY=http://localhost:%MITM_PORT%
set NO_PROXY=localhost,127.0.0.1

:: Set certificate for Node.js apps
if exist "%CERT_PEM%" (
    set NODE_EXTRA_CA_CERTS=%CERT_PEM%
)

:: SSL certificate bypass for some apps (use with caution)
set NODE_TLS_REJECT_UNAUTHORIZED=0
set REQUESTS_CA_BUNDLE=%CERT_PEM%
set SSL_CERT_FILE=%CERT_PEM%
set CURL_CA_BUNDLE=%CERT_PEM%

if "%~1"=="" (
    echo.
    echo ╔═══════════════════════════════════════════════════════════════╗
    echo ║  🔮 TokenSage - Run App with Proxy                            ║
    echo ╚═══════════════════════════════════════════════════════════════╝
    echo.
    echo Usage: run-with-proxy.bat [app-name or path]
    echo.
    echo Examples:
    echo   run-with-proxy.bat cursor      - Launch Cursor IDE
    echo   run-with-proxy.bat windsurf    - Launch Windsurf
    echo   run-with-proxy.bat code        - Launch VS Code
    echo   run-with-proxy.bat cmd         - Open CMD with proxy
    echo   run-with-proxy.bat powershell  - Open PowerShell with proxy
    echo.
    echo Quick launch options:
    echo   1 - Cursor
    echo   2 - Windsurf (Codeium)
    echo   3 - VS Code
    echo   4 - CMD with proxy
    echo   5 - PowerShell with proxy
    echo   0 - Exit
    echo.
    set /p choice="Select option (or type app name): "
    
    if "!choice!"=="1" set "APP_NAME=cursor"
    if "!choice!"=="2" set "APP_NAME=windsurf"
    if "!choice!"=="3" set "APP_NAME=code"
    if "!choice!"=="4" set "APP_NAME=cmd"
    if "!choice!"=="5" set "APP_NAME=powershell"
    if "!choice!"=="0" exit /b 0
    
    if not defined APP_NAME set "APP_NAME=!choice!"
) else (
    set "APP_NAME=%~1"
)

echo.
echo [INFO] Proxy configured: localhost:%MITM_PORT%
echo [INFO] Launching: %APP_NAME%
echo.

:: Handle common app names
set "APP_PATH="

if /i "%APP_NAME%"=="cursor" (
    :: Try to find Cursor
    for %%P in (
        "%LOCALAPPDATA%\Programs\cursor\Cursor.exe"
        "%LOCALAPPDATA%\cursor\Cursor.exe"
        "%PROGRAMFILES%\Cursor\Cursor.exe"
    ) do (
        if exist "%%~P" set "APP_PATH=%%~P"
    )
    if not defined APP_PATH (
        where cursor >nul 2>&1
        if !ERRORLEVEL! EQU 0 set "APP_PATH=cursor"
    )
)

if /i "%APP_NAME%"=="windsurf" (
    :: Try to find Windsurf
    for %%P in (
        "%LOCALAPPDATA%\Programs\windsurf\Windsurf.exe"
        "%LOCALAPPDATA%\windsurf\Windsurf.exe"
        "%PROGRAMFILES%\Windsurf\Windsurf.exe"
    ) do (
        if exist "%%~P" set "APP_PATH=%%~P"
    )
    if not defined APP_PATH (
        where windsurf >nul 2>&1
        if !ERRORLEVEL! EQU 0 set "APP_PATH=windsurf"
    )
)

if /i "%APP_NAME%"=="code" (
    where code >nul 2>&1
    if !ERRORLEVEL! EQU 0 set "APP_PATH=code"
)

if /i "%APP_NAME%"=="cmd" (
    echo [INFO] Opening CMD with proxy environment...
    echo [INFO] Test with: curl -x http://localhost:%MITM_PORT% https://api.openai.com/v1/models
    start cmd /k "echo Proxy: %HTTP_PROXY% && echo. && echo Type 'exit' to close"
    exit /b 0
)

if /i "%APP_NAME%"=="powershell" (
    echo [INFO] Opening PowerShell with proxy environment...
    start powershell -NoExit -Command "Write-Host 'Proxy: $env:HTTP_PROXY' -ForegroundColor Green"
    exit /b 0
)

:: If no special handling, try as direct path or command
if not defined APP_PATH set "APP_PATH=%APP_NAME%"

:: Check if the app exists
if exist "%APP_PATH%" (
    echo [OK] Found: %APP_PATH%
    start "" "%APP_PATH%"
) else (
    where "%APP_PATH%" >nul 2>&1
    if !ERRORLEVEL! EQU 0 (
        echo [OK] Found in PATH: %APP_PATH%
        start "" "%APP_PATH%"
    ) else (
        echo [ERROR] Could not find: %APP_NAME%
        echo.
        echo Make sure the application is installed and in your PATH.
        pause
        exit /b 1
    )
)

echo [OK] %APP_NAME% launched with proxy!
echo [INFO] All HTTP/HTTPS requests will go through TokenSage.
timeout /t 3 >nul
