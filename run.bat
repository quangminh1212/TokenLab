@echo off
setlocal enabledelayedexpansion

:: Clear stale proxy CA cert env var
if defined NODE_EXTRA_CA_CERTS ( if not exist "%NODE_EXTRA_CA_CERTS%" set "NODE_EXTRA_CA_CERTS=" )
if defined SSL_CERT_FILE ( if not exist "%SSL_CERT_FILE%" set "SSL_CERT_FILE=" )

:: === Fast PATH setup (no version checks) ===
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

:: MSVC env - set directly, no checks
set "MSVC_BASE=C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Tools\MSVC"
set "WINSDK_LIB=C:\Program Files (x86)\Windows Kits\10\Lib"
set "WINSDK_INC=C:\Program Files (x86)\Windows Kits\10\Include"
for /d %%v in ("!MSVC_BASE!\*") do set "MSVC_VER=%%~nxv"
for /d %%v in ("!WINSDK_LIB!\10.*") do set "WINSDK_VER=%%~nxv"
if defined MSVC_VER (
    set "LIB=!MSVC_BASE!\!MSVC_VER!\lib\onecore\x64;!WINSDK_LIB!\!WINSDK_VER!\um\x64;!WINSDK_LIB!\!WINSDK_VER!\ucrt\x64"
    set "INCLUDE=!MSVC_BASE!\!MSVC_VER!\include;!WINSDK_INC!\!WINSDK_VER!\ucrt;!WINSDK_INC!\!WINSDK_VER!\um;!WINSDK_INC!\!WINSDK_VER!\shared"
    set "PATH=!MSVC_BASE!\!MSVC_VER!\bin\HostX64\x64;!PATH!"
)

:: === Skip bun install if node_modules exists ===
if not exist "node_modules" (
    echo [SETUP] Installing npm deps...
    call bun install
)

:: === Kill stale processes ===
taskkill /f /im node.exe >nul 2>&1
if exist "packages\frontend\.next\dev\lock" del /f /q "packages\frontend\.next\dev\lock" >nul 2>&1

:: === Start cargo-watch for Rust hot reload (rebuild on .rs change) ===
where cargo-watch >nul 2>&1
if !errorlevel! equ 0 (
    echo [HOT] Rust watcher: auto-rebuild on .rs change
    start "tokscale-rust-watch" /min cmd /c cargo watch -x "build -p tokscale-cli" --watch crates --delay 1
) else (
    echo [BUILD] cargo-watch not found, one-time build...
    cargo build -p tokscale-cli
)

:: === Start frontend dev server (Next.js HMR) ===
echo [HOT] Frontend: http://localhost:3737
echo Press Ctrl+C to stop
echo.
call bun run dev:frontend

:: Cleanup
taskkill /fi "WINDOWTITLE eq tokscale-rust-watch" /f >nul 2>&1
