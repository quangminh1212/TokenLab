//! Agent: Kiro (port of `src/agents/kiro/index.ts`).

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
    r.push(e.j(&[&e.home, ".kiro"]));
    r.push(e.j(&[&e.xdg_data, "kiro-cli"]));
    r.push(e.j(&[&e.app_data, "kiro-cli"]));
    r.push(e.j(&[&e.app_data, "Kiro"]));
    r.push(e.j(&[&e.local_app, "Kiro"]));
    r.push(e.j(&[&e.home, "Library", "Application Support", "kiro-cli"]));
    r.push(e.j(&[&e.home, "Library", "Application Support", "Kiro"]));
    r.extend(vscode_global_storage(&["kiro.kiroagent"]));
    unique(r)
}

fn matcher() -> WalkMatch {
    Arc::new(|n, full| {
        let sep = PathFlavor::host().sep();
        n.ends_with(".jsonl") || n.ends_with(".json") || full.to_lowercase().contains("kiro")
            || full.contains(&format!("{sep}sessions{sep}"))
    })
}

async fn parse(roots: Vec<String>) -> anyhow::Result<Vec<UsageEvent>> {
    let mut opts = GenericJsonlOptions::new(AgentId::Kiro);
    opts.match_fn = Some(matcher());
    parse_generic_jsonl(&roots, &opts).await
}

pub fn agent() -> AgentModule {
    AgentModule {
        id: AgentId::Kiro,
        label: "Kiro",
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
        assert!(m("a.txt", "/x/Kiro/a.txt"));
        assert!(m("a.jsonl", "/x/a.jsonl"));
    }

    #[test]
    fn identity() {
        let a = agent();
        assert_eq!(a.id.as_str(), "kiro");
        assert_eq!(a.label, "Kiro");
    }
}
