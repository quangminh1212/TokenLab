@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

echo.
echo ╔═══════════════════════════════════════════════════════════════╗
echo ║  🔮 TokenSage - Simple Mode (Without Proxy)                   ║
echo ╚═══════════════════════════════════════════════════════════════╝
echo.

cd /d "%~dp0"

:: Build if needed
if not exist "dist\proxy.js" (
    echo [INFO] Building project...
    call npm run build
)

:: Start TokenSage API and Dashboard only
echo [INFO] Starting TokenSage API server...
echo.
echo ═══════════════════════════════════════════════════════════════
echo   This mode runs TokenSage WITHOUT traffic interception.
echo   
echo   To track AI usage, use one of these methods:
echo   
echo   1. MCP Tools (in Antigravity/Cursor):
echo      - Ask AI to call: get_total_stats
echo      - Ask AI to call: auto_track_usage with your usage data
echo   
echo   2. Manual API calls:
echo      curl http://localhost:4000/ingest -X POST ^
echo           -H "Content-Type: application/json" ^
echo           -d "{\"model\":\"gemini-2.5-pro\",\"input_tokens\":1000,\"output_tokens\":500}"
echo   
echo   3. Dashboard: http://localhost:4001
echo ═══════════════════════════════════════════════════════════════
echo.

:: Kill old processes
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":4000.*LISTENING"') do taskkill /F /PID %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":4001.*LISTENING"') do taskkill /F /PID %%a >nul 2>&1

:: Open dashboard
start http://localhost:4001

:: Start proxy server (API + Dashboard)
node dist/proxy.js

pause
