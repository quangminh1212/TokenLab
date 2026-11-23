@echo off
setlocal
cd /d "%~dp0rust"
where cargo >nul 2>&1 || (echo [ERROR] Rust (cargo) not found. & exit /b 1)
echo === TokenLab (Rust) === http://127.0.0.1:3737
cargo run --release -- serve %*
