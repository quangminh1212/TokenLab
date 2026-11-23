#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/rust"
command -v cargo >/dev/null || { echo "[ERROR] Rust (cargo) not found."; exit 1; }
echo "=== TokenLab (Rust) === http://127.0.0.1:3737"
exec cargo run --release -- serve "$@"
