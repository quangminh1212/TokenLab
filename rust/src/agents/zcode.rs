//! Agent: ZCode (port of `src/agents/zcode/index.ts`).

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
    r.push(e.j(&[&e.home, ".zcode"]));
    r.push(e.j(&[&e.xdg_data, "zcode"]));
    r.push(e.j(&[&e.xdg_config, "zcode"]));
    r.push(e.j(&[&e.app_data, "zcode"]));
    r.push(e.j(&[&e.app_data, "ZCode"]));
    r.push(e.j(&[&e.local_app, "zcode"]));
    r.push(e.j(&[&e.local_app, "ZCode"]));
    r.push(e.j(&[&e.app_data, "z.ai", "zcode"]));
    r.push(e.j(&[&e.app_data, "Z.ai", "ZCode"]));
    r.push(e.j(&[&e.local_app, "Programs", "ZCode"]));
    unique(r)
}

fn matcher() -> WalkMatch {
    Arc::new(|n, full| {
        let p = full.replace('\\', "/").to_lowercase();
        if p.contains("/node_modules/") || p.contains("/.git/") { return false; }
        n.ends_with(".jsonl") || n.ends_with(".json") || n.contains("session") || n.contains("usage") || n.contains("history")
    })
}

async fn parse(roots: Vec<String>) -> anyhow::Result<Vec<UsageEvent>> {
    let mut opts = GenericJsonlOptions::new(AgentId::Zcode);
    opts.match_fn = Some(matcher());
    parse_generic_jsonl(&roots, &opts).await
}

pub fn agent() -> AgentModule {
    AgentModule {
        id: AgentId::Zcode,
        label: "ZCode",
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
        assert!(!m("a.json", "/tmp/x/node_modules/a.json"));
        assert!(m("usage.txt", "/tmp/x/usage.txt"));
        assert!(m("a.jsonl", "/x/a.jsonl"));
    }

    #[test]
    fn identity() {
        let a = agent();
        assert_eq!(a.id.as_str(), "zcode");
        assert_eq!(a.label, "ZCode");
    }
}
