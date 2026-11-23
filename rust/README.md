# TokenLab (Rust + Astro)

Native port of TokenLab. The Rust crate in this directory replaces the Node.js
CLI/server (`src/`, kept in the repo as the behavioral reference); the dashboard UI is the
Astro site in `../web`. Data files and caches under `%LOCALAPPDATA%\tokenlab` are
shared with the TypeScript build, so both can be used on the same machine.

## Build

Requirements: Rust (stable), and Node.js 20+ with npm for the UI build.

```powershell
cd rust
cargo build --release
# -> rust\target\release\tokenlab.exe  (single self-contained binary, UI embedded)
```

`web/dist` is embedded into the binary at compile time (`rust-embed`), so it must
be built first. `rust/build.rs` does this automatically for **release** builds:

1. skips the UI build if `web/dist/index.html` is newer than everything in
   `web/src`, `web/public` and the npm/Astro config;
2. otherwise runs `npm ci` (only if `web/node_modules` is missing) and `npm run build` in `web/`.

Debug builds, `cargo check` and `cargo test` never invoke Node.

Manual equivalent (CI or when you prefer explicit steps):

```powershell
cd web;  npm ci;  npm run build;  cd ..
cd rust; $env:TOKENLAB_SKIP_WEB_BUILD = "1"; cargo build --release
```

| Variable | Effect |
| --- | --- |
| `TOKENLAB_SKIP_WEB_BUILD=1` | Never run the Astro build from `build.rs`. |
| `TOKENLAB_BUILD_WEB=1` | Force the UI build (also for debug profile) even if `web/dist` is fresh. |
| `TOKENLAB_REQUIRE_WEB=1` | Fail the build if the UI cannot be built (default: warn, ship API-only). |

If `web/dist` is changed after the last compile, re-run `cargo build --release`
(the embedded files are tracked, so the binary is rebuilt).

## Run

```powershell
rust\target\release\tokenlab.exe serve            # http://127.0.0.1:3737
rust\target\release\tokenlab.exe --help
```

Same commands and flags as the Node CLI: `serve`, `setup`, `autostart`, `stats`,
`cost`, `scan`, `doctors`, `backup upload|download|status`, `--version`, `--help`.
`--open` is required to open the browser (`setup` does not open it otherwise;
`TOKENLAB_OPEN=1` works for `serve`). `serve` also honors `TOKENLAB_HOST`,
`TOKENLAB_PORT`, `TOKENLAB_NO_UI=1` and `TOKENLAB_NO_TRAY=1`.

Autostart / Desktop shortcut now launch `tokenlab.exe serve` directly (no Node
needed). Running `tokenlab.exe setup` from a release build registers that
executable path, so keep the binary at a stable location (e.g. copy it to
`%LOCALAPPDATA%\Programs\tokenlab\`) before enabling autostart.

## Development

```powershell
cd web;  npm run dev          # Astro dev server (UI only)
cd rust; cargo run -- serve   # API server; serves the embedded web/dist if present
cargo test
```

Notes:

- `cli-wrapper.cjs` (the Node ESM shim) has no equivalent: the native binary is the entry point.
- `tokenlab doctors --json` reports `"node": "rust"` since there is no Node runtime.
