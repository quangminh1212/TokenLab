//! Agent: Mux (port of `src/agents/mux/index.ts`).

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
    r.push(e.j(&[&e.home, ".mux"]));
    r.push(e.j(&[&e.xdg_data, "mux"]));
    r.push(e.j(&[&e.app_data, "mux"]));
    unique(r)
}

fn matcher() -> WalkMatch {
    Arc::new(|n, full| {
        let sep = PathFlavor::host().sep();
        n.ends_with(".jsonl") || n.ends_with(".json") || full.contains(&format!("{sep}sessions{sep}"))
    })
}

async fn parse(roots: Vec<String>) -> anyhow::Result<Vec<UsageEvent>> {
    let mut opts = GenericJsonlOptions::new(AgentId::Mux);
    opts.match_fn = Some(matcher());
    parse_generic_jsonl(&roots, &opts).await
}

pub fn agent() -> AgentModule {
    AgentModule {
        id: AgentId::Mux,
        label: "Mux",
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
        assert_eq!(m("a.json", "/x/a.json"), true);
        assert_eq!(m("a.txt", "/x/a.txt"), false);
        let sep = PathFlavor::host().sep();
        assert!(m("x.txt", &format!("a{sep}sessions{sep}x.txt")));
    }

    #[test]
    fn identity() {
        let a = agent();
        assert_eq!(a.id.as_str(), "mux");
        assert_eq!(a.label, "Mux");
    }
}
