//! Agent: Continue.dev (port of `src/agents/continue/index.ts`).

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
    r.push(e.j(&[&e.home, ".continue"]));
    r.push(e.j(&[&e.xdg_config, "continue"]));
    r.push(e.j(&[&e.xdg_data, "continue"]));
    r.push(e.j(&[&e.app_data, "Continue"]));
    r.extend(vscode_global_storage(&["continue.continue"]));
    unique(r)
}

fn matcher() -> WalkMatch {
    Arc::new(|n, full| {
        let sep = PathFlavor::host().sep();
        n.ends_with(".jsonl") || n.ends_with(".json")
            || full.contains(&format!("{sep}sessions{sep}"))
            || full.contains(&format!("{sep}dev_data{sep}"))
            || n.contains("usage") || n.contains("token")
    })
}

async fn parse(roots: Vec<String>) -> anyhow::Result<Vec<UsageEvent>> {
    let mut opts = GenericJsonlOptions::new(AgentId::Continue);
    opts.match_fn = Some(matcher());
    parse_generic_jsonl(&roots, &opts).await
}

pub fn agent() -> AgentModule {
    AgentModule {
        id: AgentId::Continue,
        label: "Continue.dev",
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
        assert!(m("tokens.txt", "/x/tokens.txt"));
        assert!(m("a.jsonl", "/x/a.jsonl"));
    }

    #[test]
    fn identity() {
        let a = agent();
        assert_eq!(a.id.as_str(), "continue");
        assert_eq!(a.label, "Continue.dev");
    }
}
