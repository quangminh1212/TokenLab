//! Agent: Open Code Review (port of `src/agents/opencodereview/index.ts`).

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
    r.push(e.j(&[&e.home, ".opencodereview"]));
    r.push(e.j(&[&e.home, ".open-code-review"]));
    r.push(e.j(&[&e.xdg_data, "opencodereview"]));
    r.push(e.j(&[&e.xdg_config, "opencodereview"]));
    r.push(e.j(&[&e.xdg_config, "open-code-review"]));
    r.push(e.j(&[&e.app_data, "opencodereview"]));
    r.push(e.j(&[&e.app_data, "open-code-review"]));
    r.push(e.j(&[&e.local_app, "opencodereview"]));
    unique(r)
}

fn matcher() -> WalkMatch {
    Arc::new(|n, full| {
        let p = full.replace('\\', "/").to_lowercase();
        if p.contains("/node_modules/") || p.contains("/.git/") { return false; }
        n.ends_with(".jsonl") || n.ends_with(".json") || n.contains("review") || n.contains("usage") || n.contains("session")
    })
}

async fn parse(roots: Vec<String>) -> anyhow::Result<Vec<UsageEvent>> {
    let mut opts = GenericJsonlOptions::new(AgentId::Opencodereview);
    opts.match_fn = Some(matcher());
    parse_generic_jsonl(&roots, &opts).await
}

pub fn agent() -> AgentModule {
    AgentModule {
        id: AgentId::Opencodereview,
        label: "Open Code Review",
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
        assert!(!m("a.json", "/tmp/x/.git/a.json"));
        assert!(m("review.txt", "/tmp/x/review.txt"));
        assert!(m("a.jsonl", "/x/a.jsonl"));
    }

    #[test]
    fn identity() {
        let a = agent();
        assert_eq!(a.id.as_str(), "opencodereview");
        assert_eq!(a.label, "Open Code Review");
    }
}
