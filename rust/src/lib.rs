//! TokenLab - local AI coding agent token usage tracker (Rust port of the
//! TypeScript implementation under `src/`).

pub mod agents;
pub mod aggregate;
pub mod autostart;
pub mod backup;
pub mod cli;
pub mod config;
pub mod flag_report;
pub mod live_rate;
pub mod openrouter_models;
pub mod paths;
pub mod pricing;
pub mod process_guard;
pub mod rate_guard;
pub mod server;
pub mod setup;
pub mod tray;
pub mod types;
pub mod util;
pub mod version;

// Public API surface mirroring `src/index.ts`.
pub use aggregate::{aggregate, cost_report};
pub use agents::{agent_path_specs, all_agents as AGENTS, detect_agents, scan_all};
pub use config::{config_path, load_config, save_config, set_custom_rates};
pub use pricing::{
    list_pricing_catalog, price_tokens, reprice_events, BUNDLED_RATES, RATES_VERSION,
};
pub use server::start_server;
pub use version::VERSION;
