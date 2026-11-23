//! Agent: Cline (port of `src/agents/cline/index.ts`).

#[allow(unused_imports)]
use crate::agents::shared::env::{env_chain, jetbrains_roots, path_env, unique, vscode_global_storage};
use crate::agents::shared::generic_jsonl::{parse_generic_jsonl, GenericJsonlOptions};
use crate::agents::{parse_fn, AgentModule};
use crate::util::WalkMatch;
use std::sync::Arc;
#[allow(unused_imports)]
use crate::util::{app_data_dir, env_nonempty, home_dir, host_platform, js_trim};
use crate::types::{AgentId, UsageEvent};

/// Local data roots to scan on this machine.
pub fn roots() -> Vec<String> {
    let e = path_env();
    let mut r: Vec<String> = Vec::new();
    r.push(e.j(&[&e.home, ".cline"]));
    r.extend(vscode_global_storage(&["saoudrizwan.claude-dev"]));
    unique(r)
}

fn matcher() -> WalkMatch {
    Arc::new(|n, full| {
        let _ = full;
        n == "ui_messages.json" || n.contains("api_req") || n.ends_with(".jsonl") || n.ends_with(".json")
    })
}

async fn parse(roots: Vec<String>) -> anyhow::Result<Vec<UsageEvent>> {
    let mut opts = GenericJsonlOptions::new(AgentId::Cline);
    opts.match_fn = Some(matcher());
    parse_generic_jsonl(&roots, &opts).await
}

pub fn agent() -> AgentModule {
    AgentModule {
        id: AgentId::Cline,
        label: "Cline",
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
        assert_eq!(m("ui_messages.json", "/x/ui_messages.json"), true);
        assert_eq!(m("api_req_1.txt", "/x/api_req_1.txt"), true);
        assert_eq!(m("a.txt", "/x/a.txt"), false);
    }

    #[test]
    fn identity() {
        let a = agent();
        assert_eq!(a.id.as_str(), "cline");
        assert_eq!(a.label, "Cline");
    }
}
