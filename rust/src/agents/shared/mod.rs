//! Port of `src/agents/shared/`. Shared helpers used by the per-agent parsers.
//! (`types.ts` lives in `agents/mod.rs` as `AgentModule` / `AgentPathSpec`.)

pub mod env;
pub mod generic_jsonl;
pub mod router_light;
pub mod router_usage;
pub mod usage_fields;
