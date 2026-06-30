@echo off
setlocal enabledelayedexpansion
echo ========================================
echo Tokscale - Auto Setup, Build and Run
echo ========================================
echo.

:: Setup Bun
echo [1/5] Checking Bun...
set BUN_PATH=
where bun >nul 2>&1
if !errorlevel! neq 0 (
    if exist "%USERPROFILE%\.bun\bin\bun.exe" (
        set BUN_PATH=%USERPROFILE%\.bun\bin\bun.exe
        echo [OK] Bun found at default path
        "!BUN_PATH!" --version
    ) else (
        echo [WARN] Bun not found, installing...
        powershell -c "irm bun.sh/install.ps1 | iex"
        if !errorlevel! neq 0 (
            echo [ERROR] Failed to install Bun
            pause
            exit /b 1
        )
        set BUN_PATH=%USERPROFILE%\.bun\bin\bun.exe
        echo [OK] Bun installed successfully
    )
) else (
    bun --version
    echo [OK] Bun is installed
)
echo.

:: Setup Rust/Cargo
echo [2/5] Checking Rust/Cargo...
set CARGO_PATH=
where cargo >nul 2>&1
if !errorlevel! neq 0 (
    if exist "%USERPROFILE%\.cargo\bin\cargo.exe" (
        set CARGO_PATH=%USERPROFILE%\.cargo\bin\cargo.exe
        echo [OK] Cargo found at default path
        "!CARGO_PATH!" --version
    ) else if exist "%USERPROFILE%\.rustup\toolchains\stable-x86_64-pc-windows-msvc\bin\cargo.exe" (
        set CARGO_PATH=%USERPROFILE%\.rustup\toolchains\stable-x86_64-pc-windows-msvc\bin\cargo.exe
        echo [OK] Cargo found at toolchain path
        "!CARGO_PATH!" --version
    ) else (
        echo [WARN] Rust/Cargo not found, installing...
        powershell -c "Invoke-WebRequest -Uri https://win.rustup.rs/x86_64 -OutFile rustup-init.exe; .\rustup-init.exe -y --default-toolchain stable"
        if !errorlevel! neq 0 (
            echo [ERROR] Failed to install Rust
            pause
            exit /b 1
        )
        del rustup-init.exe
        set CARGO_PATH=%USERPROFILE%\.cargo\bin\cargo.exe
        echo [OK] Rust installed successfully
    )
) else (
    cargo --version
    echo [OK] Rust/Cargo is installed
)
echo.

:: Setup MSVC environment for Rust linking
echo [2.5] Setting up MSVC environment...
set "MSVC_BASE=C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Tools\MSVC"
set "WINSDK_LIB=C:\Program Files (x86)\Windows Kits\10\Lib"
set "WINSDK_INC=C:\Program Files (x86)\Windows Kits\10\Include"
set "MSVC_VER="
set "WINSDK_VER="
if exist "!MSVC_BASE!" (
    for /d %%v in ("!MSVC_BASE!\*") do set "MSVC_VER=%%~nxv"
)
if exist "!WINSDK_LIB!" (
    for /d %%v in ("!WINSDK_LIB!\10.*") do set "WINSDK_VER=%%~nxv"
)
if defined MSVC_VER if defined WINSDK_VER (
    set "LIB=!MSVC_BASE!\!MSVC_VER!\lib\onecore\x64;!WINSDK_LIB!\!WINSDK_VER!\um\x64;!WINSDK_LIB!\!WINSDK_VER!\ucrt\x64"
    set "INCLUDE=!MSVC_BASE!\!MSVC_VER!\include;!WINSDK_INC!\!WINSDK_VER!\ucrt;!WINSDK_INC!\!WINSDK_VER!\um;!WINSDK_INC!\!WINSDK_VER!\shared"
    :: Check if MSVC headers are installed
    if not exist "!MSVC_BASE!\!MSVC_VER!\include\vcruntime.h" (
        echo [ERROR] MSVC C++ headers not found. VS installation is incomplete.
        echo Please run install_msvc.bat to install C++ build tools, or open Visual Studio Installer
        echo and add "Desktop development with C++" workload.
        pause
        exit /b 1
    )
    :: Add cargo and MSVC bin to PATH
    if exist "%USERPROFILE%\.cargo\bin\cargo.exe" set "PATH=%USERPROFILE%\.cargo\bin;!PATH!"
    set "PATH=!MSVC_BASE!\!MSVC_VER!\bin\HostX64\x64;!PATH!"
    echo [OK] MSVC !MSVC_VER! + Windows SDK !WINSDK_VER!
) else (
    echo [ERROR] MSVC or Windows SDK not found. Please install Visual Studio 2022 with C++ build tools.
    pause
    exit /b 1
)
echo.

:: Install npm dependencies
echo [3/5] Installing npm dependencies...
if defined BUN_PATH (
    call "!BUN_PATH!" install
) else (
    call bun install
)
if !errorlevel! neq 0 (
    echo [ERROR] Failed to install npm dependencies
    pause
    exit /b 1
)
echo [OK] Npm dependencies installed
echo.

:: Build Rust core
echo [4/5] Building Rust core (tokscale-cli)...
if defined CARGO_PATH (
    call "!CARGO_PATH!" build --release -p tokscale-cli
) else (
    call cargo build --release -p tokscale-cli
)
if !errorlevel! neq 0 (
    echo [ERROR] Rust build failed
    pause
    exit /b 1
)
echo [OK] Rust core build successful
echo.

:: Build npm packages
echo [5/5] Building npm packages...
if defined BUN_PATH (
    call "!BUN_PATH!" run build
) else (
    call bun run build
)
if !errorlevel! neq 0 (
    echo [ERROR] Npm packages build failed
    pause
    exit /b 1
)
echo [OK] Npm packages build successful
echo.

echo ========================================
echo Starting frontend dev server...
echo ========================================
echo Frontend will run at http://localhost:3000
echo Press Ctrl+C to stop server
echo.
if defined BUN_PATH (
    call "!BUN_PATH!" run dev:frontend
) else (
    call bun run dev:frontend
)
