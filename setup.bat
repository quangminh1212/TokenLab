@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

echo.
echo ╔═══════════════════════════════════════════════════════════════╗
echo ║              🔮 TokenSage - Complete Setup                    ║
echo ║         AI Usage Tracker for All Coding Assistants            ║
echo ╚═══════════════════════════════════════════════════════════════╝
echo.

cd /d "%~dp0"

:: ======================= CHECK NODE.JS =======================
echo [1/6] Checking Node.js...
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo       ❌ Node.js not found!
    echo       Please install Node.js from https://nodejs.org/
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('node -v') do set NODE_VER=%%i
echo       ✅ Node.js %NODE_VER% found

:: ======================= CHECK PYTHON =======================
echo.
echo [2/6] Checking Python (for full tracking mode)...
set PYTHON_OK=0
where python >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    for /f "tokens=*" %%i in ('python --version 2^>^&1') do set PY_VER=%%i
    echo       ✅ !PY_VER! found
    set PYTHON_OK=1
) else (
    echo       ⚠️  Python not found
    echo       Basic mode will work, but Full mode requires Python
    echo       Install from: https://python.org/
)

:: ======================= INSTALL MITMPROXY =======================
echo.
echo [3/6] Checking mitmproxy (for system-wide tracking)...
if "%PYTHON_OK%"=="1" (
    where mitmweb >nul 2>&1
    if %ERRORLEVEL% NEQ 0 (
        echo       Installing mitmproxy...
        pip install mitmproxy --quiet
        if %ERRORLEVEL% EQU 0 (
            echo       ✅ mitmproxy installed
        ) else (
            echo       ⚠️  mitmproxy installation failed
            echo       Full mode will not be available
        )
    ) else (
        echo       ✅ mitmproxy already installed
    )
) else (
    echo       ⏭️  Skipping (Python required)
)

:: ======================= INSTALL NPM DEPENDENCIES =======================
echo.
echo [4/6] Installing Node.js dependencies...
call npm install --silent
if %ERRORLEVEL% NEQ 0 (
    echo       ❌ Failed to install dependencies!
    pause
    exit /b 1
)
echo       ✅ Dependencies installed

:: ======================= FIX VULNERABILITIES =======================
echo.
echo [5/6] Checking for vulnerabilities...
call npm audit fix --silent >nul 2>&1
echo       ✅ Security check completed

:: ======================= BUILD PROJECT =======================
echo.
echo [6/6] Building TypeScript project...
call npm run build
if %ERRORLEVEL% NEQ 0 (
    echo       ❌ Build failed!
    pause
    exit /b 1
)
echo       ✅ Build completed

:: ======================= CREATE DATA DIRECTORY =======================
if not exist "data" mkdir data

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
echo ║  To start TokenSage:                                          ║
echo ║                                                               ║
echo ║  run.bat                                                       ║
echo ║    - Choose [1] Basic Mode: Proxy server for direct tracking  ║
echo ║    - Choose [2] Full Mode: System-wide traffic interception   ║
echo ║    - Choose [3] Dashboard: View existing usage data           ║
echo ║                                                               ║
echo ╠═══════════════════════════════════════════════════════════════╣
echo ║  Endpoints:                                                   ║
echo ║  Dashboard:    http://localhost:4001                          ║
echo ║  Proxy:        http://localhost:4000                          ║
echo ║  Stats API:    http://localhost:4000/stats                    ║
echo ║  Settings:     http://localhost:4000/settings                 ║
echo ╚═══════════════════════════════════════════════════════════════╝
echo.

:: ======================= FIRST RUN OPTION =======================
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
