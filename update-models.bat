@echo off
REM =====================================================
REM MCP TokenSage - Update Models Data
REM Crawl thông tin models từ OpenRouter API
REM =====================================================

echo.
echo ========================================
echo   MCP TokenSage - Model Data Updater
echo ========================================
echo.

REM Kiểm tra Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed!
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

REM Di chuyển đến thư mục dự án
cd /d "%~dp0"

REM Kiểm tra node_modules
if not exist "node_modules" (
    echo [INFO] Installing dependencies...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] Failed to install dependencies!
        pause
        exit /b 1
    )
)

REM Chạy crawler
echo [INFO] Starting model data crawler...
echo.

call npx tsx src/crawler.ts

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Crawler failed!
    pause
    exit /b 1
)

echo.
echo ========================================
echo   Update completed successfully!
echo ========================================
echo.

REM Hiển thị thông tin data
if exist "data\models.json" (
    echo [INFO] Data files location: %~dp0data\
    echo.
    dir /b data\*.json 2>nul
)

echo.
pause
