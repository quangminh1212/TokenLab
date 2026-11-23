//! Agent: Warp AI (port of `src/agents/warp/index.ts`).

#[allow(unused_imports)]
use crate::agents::shared::env::{env_chain, jetbrains_roots, path_env, unique, vscode_global_storage};
use crate::agents::shared::generic_jsonl::{parse_generic_jsonl, GenericJsonlOptions};
use crate::agents::{parse_fn, AgentModule};
use crate::util::{PathFlavor, WalkMatch};
use std::sync::Arc;
#[allow(unused_imports)]
use crate::util::{app_data_dir, env_nonempty, home_dir, host_platform, js_trim};
use crate::types::{AgentId, UsageEvent};

/// Local data roots to scan on this machine.
pub fn roots() -> Vec<String> {
    let e = path_env();
    let mut r: Vec<String> = Vec::new();
    r.push(e.j(&[&e.app_data, "dev.warp.Warp-Stable"]));
    r.push(e.j(&[&e.app_data, "dev.warp.Warp"]));
    r.push(e.j(&[&e.app_data, "Warp"]));
    r.push(e.j(&[&e.local_app, "warp"]));
    r.push(e.j(&[&e.local_app, "dev.warp.Warp-Stable"]));
    r.push(e.j(&[&e.xdg_data, "warp"]));
    r.push(e.j(&[&e.xdg_config, "warp"]));
    r.push(e.j(&[&e.home, ".warp"]));
    r.push(e.j(&[&e.home, "AppData", "Local", "warp"]));
    r.push(e.j(&[&e.home, "Library", "Group Containers", "2BBY89MBSN.dev.warp"]));
    r.push(e.j(&[&e.home, "Library", "Application Support", "dev.warp.Warp-Stable"]));
    unique(r)
}

fn matcher() -> WalkMatch {
    Arc::new(|n, _full| n.ends_with(".jsonl") || n.ends_with(".json"))
}

async fn parse(roots: Vec<String>) -> anyhow::Result<Vec<UsageEvent>> {
    let mut opts = GenericJsonlOptions::new(AgentId::Warp);
    opts.match_fn = Some(matcher());
    parse_generic_jsonl(&roots, &opts).await
}

pub fn agent() -> AgentModule {
    AgentModule {
        id: AgentId::Warp,
        label: "Warp AI",
        roots,
        parse: parse_fn(parse),
        parse_light: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matcher_rules() {
        let m = matcher();
        assert!(!m("a.txt", "/x/a.txt"));
        assert!(m("a.json", "/x/a.json"));
        assert!(m("a.jsonl", "/x/a.jsonl"));
    }

    #[test]
    fn identity() {
        let a = agent();
        assert_eq!(a.id.as_str(), "warp");
        assert_eq!(a.label, "Warp AI");
    }
}
