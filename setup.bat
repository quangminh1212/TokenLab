@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

:: Check for silent mode
set SILENT=0
if "%1"=="--silent" set SILENT=1

if %SILENT%==0 (
    echo.
    echo ╔═══════════════════════════════════════════════════════════════╗
    echo ║              🔮 TokenSage - Auto Setup                        ║
    echo ║         AI Usage Tracker for All Coding Assistants            ║
    echo ╚═══════════════════════════════════════════════════════════════╝
    echo.
)

cd /d "%~dp0"

set SETUP_NEEDED=0
set STEPS_DONE=0
set TOTAL_STEPS=7

:: ======================= CHECK NODE.JS =======================
set /a STEPS_DONE+=1
echo [%STEPS_DONE%/%TOTAL_STEPS%] Checking Node.js...
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo       ❌ Node.js not found!
    echo       Please install Node.js from https://nodejs.org/
    echo.
    echo       After installing, run this script again.
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('node -v') do set NODE_VER=%%i
echo       ✅ Node.js %NODE_VER% found

:: ======================= CHECK PYTHON =======================
set /a STEPS_DONE+=1
echo.
echo [%STEPS_DONE%/%TOTAL_STEPS%] Checking Python...
set PYTHON_OK=0
where python >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    for /f "tokens=*" %%i in ('python --version 2^>^&1') do set PY_VER=%%i
    echo       ✅ !PY_VER! found
    set PYTHON_OK=1
) else (
    echo       ⚠️  Python not found - attempting to install...
    
    :: Try winget first
    where winget >nul 2>&1
    if %ERRORLEVEL% EQU 0 (
        echo       Installing Python via winget...
        winget install Python.Python.3.12 --silent --accept-package-agreements --accept-source-agreements
        if %ERRORLEVEL% EQU 0 (
            echo       ✅ Python installed! Please restart this script.
            pause
            exit /b 0
        )
    )
    
    echo       ❌ Could not auto-install Python.
    echo       Please install manually from: https://python.org/
    echo       Make sure to check "Add Python to PATH" during installation.
)

:: ======================= CHECK/INSTALL MITMPROXY =======================
set /a STEPS_DONE+=1
echo.
echo [%STEPS_DONE%/%TOTAL_STEPS%] Checking mitmproxy...
if "%PYTHON_OK%"=="1" (
    where mitmweb >nul 2>&1
    if %ERRORLEVEL% NEQ 0 (
        echo       📦 mitmproxy not found - Installing...
        pip install mitmproxy
        if %ERRORLEVEL% EQU 0 (
            echo       ✅ mitmproxy installed successfully
        ) else (
            echo       ⚠️  mitmproxy installation failed
        )
    ) else (
        echo       ✅ mitmproxy already installed
    )
) else (
    echo       ⏭️  Skipping (Python required)
)

:: ======================= CHECK/INSTALL NPM DEPENDENCIES =======================
set /a STEPS_DONE+=1
echo.
echo [%STEPS_DONE%/%TOTAL_STEPS%] Checking Node.js dependencies...
if not exist "node_modules" (
    echo       📦 Installing dependencies...
    call npm install --silent
    if %ERRORLEVEL% NEQ 0 (
        echo       ❌ Failed to install dependencies!
        pause
        exit /b 1
    )
    echo       ✅ Dependencies installed
) else (
    :: Check if package.json is newer than node_modules
    echo       ✅ Dependencies already installed
    echo       Checking for updates...
    call npm install --silent
)

:: ======================= FIX VULNERABILITIES =======================
set /a STEPS_DONE+=1
echo.
echo [%STEPS_DONE%/%TOTAL_STEPS%] Checking security vulnerabilities...
call npm audit fix --silent >nul 2>&1
echo       ✅ Security check completed

:: ======================= BUILD PROJECT =======================
set /a STEPS_DONE+=1
echo.
echo [%STEPS_DONE%/%TOTAL_STEPS%] Building project...
if not exist "dist\proxy.js" (
    echo       📦 Building TypeScript...
    call npm run build
    if %ERRORLEVEL% NEQ 0 (
        echo       ❌ Build failed!
        pause
        exit /b 1
    )
    echo       ✅ Build completed
) else (
    :: Check if src is newer than dist
    echo       ✅ Build exists - rebuilding to ensure latest...
    call npm run build >nul 2>&1
    echo       ✅ Build updated
)

:: ======================= CREATE DATA DIRECTORY =======================
if not exist "data" mkdir data

:: ======================= CHECK/INSTALL MITMPROXY CERTIFICATE =======================
set /a STEPS_DONE+=1
echo.
echo [%STEPS_DONE%/%TOTAL_STEPS%] Checking mitmproxy certificate...

set CERT_FILE=%USERPROFILE%\.mitmproxy\mitmproxy-ca-cert.cer
set CERT_INSTALLED=0

:: Check if certificate file exists
if exist "%CERT_FILE%" (
    echo       ✅ Certificate file found
    
    :: Check if certificate is installed in Windows cert store
    certutil -verifystore Root mitmproxy >nul 2>&1
    if %ERRORLEVEL% EQU 0 (
        echo       ✅ Certificate already installed in Windows
        set CERT_INSTALLED=1
    ) else (
        echo       📦 Certificate not installed in Windows - Installing...
        
        :: Need admin rights to install certificate
        net session >nul 2>&1
        if %ERRORLEVEL% EQU 0 (
            certutil -addstore -f Root "%CERT_FILE%" >nul 2>&1
            if %ERRORLEVEL% EQU 0 (
                echo       ✅ Certificate installed successfully
                set CERT_INSTALLED=1
            ) else (
                echo       ⚠️  Failed to install certificate automatically
            )
        ) else (
            echo       ⚠️  Need admin rights to install certificate
            echo       Run this script as Administrator, or install manually:
            echo       1. Run mitmproxy once: mitmweb
            echo       2. Open http://mitm.it and download Windows cert
            echo       3. Install to "Trusted Root Certification Authorities"
        )
    )
) else (
    echo       ⚠️  Certificate not generated yet
    echo       It will be created when mitmproxy runs for the first time.
    echo       Then visit http://mitm.it to install it.
)

:: ======================= SETUP COMPLETE =======================
echo.
echo ╔═══════════════════════════════════════════════════════════════╗
echo ║              ✅ Setup Complete!                               ║
echo ╠═══════════════════════════════════════════════════════════════╣
echo ║                                                               ║
echo ║  Supported AI Tools (40+ providers):                          ║
echo ║  ────────────────────────────────────────────────────────────  ║
echo ║  IDEs:     Antigravity, Cursor, Windsurf, Kiro, Copilot,      ║
echo ║           Zed, Tabnine, Cody, JetBrains AI, Replit            ║
echo ║                                                               ║
echo ║  LLMs:     OpenAI, Claude, Gemini, Bedrock, DeepSeek,         ║
echo ║           Groq, Mistral, Together, Perplexity, and more...    ║
echo ║                                                               ║
echo ║  Local:    Ollama, LM Studio                                  ║
echo ║                                                               ║
echo ╠═══════════════════════════════════════════════════════════════╣
echo ║  To start: run.bat                                             ║
echo ║                                                               ║
echo ║  Endpoints:                                                   ║
echo ║  Dashboard:    http://localhost:4001                          ║
echo ║  Proxy:        http://localhost:4000                          ║
echo ║  mitmweb:      http://127.0.0.1:8081                          ║
echo ╚═══════════════════════════════════════════════════════════════╝
echo.

:: Show certificate warning if not installed (only in interactive mode)
if %SILENT%==0 (
    if "%CERT_INSTALLED%"=="0" (
        echo ╔═══════════════════════════════════════════════════════════════╗
        echo ║  ⚠️  FIRST RUN: Certificate Setup Required                    ║
        echo ║                                                               ║
        echo ║  When you run TokenSage for the first time:                   ║
        echo ║  1. Open http://mitm.it in your browser                       ║
        echo ║  2. Click "Windows" to download certificate                   ║
        echo ║  3. Install to "Trusted Root Certification Authorities"       ║
        echo ║  4. Enable System Proxy: 127.0.0.1:8080                       ║
        echo ╚═══════════════════════════════════════════════════════════════╝
        echo.
    )
)

:: ======================= ASK TO RUN (only in interactive mode) =======================
if %SILENT%==1 (
    :: Silent mode - just exit successfully
    exit /b 0
)

set /p RUN_NOW="Start TokenSage now? [Y/n]: "
if /i "%RUN_NOW%"=="" set RUN_NOW=Y
if /i "%RUN_NOW%"=="Y" (
    echo.
    call run.bat
) else (
    echo.
    echo Run 'run.bat' when ready to start TokenSage.
    echo.
    pause
)

