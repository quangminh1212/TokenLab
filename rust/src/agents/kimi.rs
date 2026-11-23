//! Agent: Kimi CLI (port of `src/agents/kimi/index.ts`).

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
    r.push(e.expand_home(&env_nonempty("KIMI_SHARE_DIR").unwrap_or_else(|| e.j(&[&e.home, ".kimi"]))));
    r.push(e.j(&[&e.home, ".kimi"]));
    r.push(e.j(&[&e.home, ".kimi-code"]));
    unique(r)
}

fn matcher() -> WalkMatch {
    Arc::new(|n, _full| n == "wire.jsonl" || n.ends_with(".jsonl") || n.contains("usage"))
}

async fn parse(roots: Vec<String>) -> anyhow::Result<Vec<UsageEvent>> {
    let mut opts = GenericJsonlOptions::new(AgentId::Kimi);
    opts.match_fn = Some(matcher());
    parse_generic_jsonl(&roots, &opts).await
}

pub fn agent() -> AgentModule {
    AgentModule {
        id: AgentId::Kimi,
        label: "Kimi CLI",
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
        assert!(m("wire.jsonl", "/x/wire.jsonl"));
    }

    #[tokio::test]
    async fn parses_fixture_rows() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("wire.jsonl");
        let row = r#"{"model":"m-1","timestamp":"2026-01-02T03:04:05Z","cwd":"/w","usage":{"input_tokens":10,"output_tokens":5}}"#;
        let body = if "wire.jsonl".ends_with(".jsonl") { format!("{row}
not json
{{}}
") } else { format!("[{row}]") };
        std::fs::write(&file, body).unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let ev = (agent().parse)(vec![root]).await.unwrap();
        assert_eq!(ev.len(), 1);
        assert_eq!(ev[0].agent, AgentId::Kimi);
        assert_eq!(ev[0].input_tokens, 10.0);
        assert_eq!(ev[0].output_tokens, 5.0);
        assert_eq!(ev[0].workspace.as_deref(), Some("/w"));
        assert_eq!(ev[0].model.as_deref(), Some("m-1"));
        assert_eq!(ev[0].timestamp, "2026-01-02T03:04:05.000Z");
        assert_eq!(ev[0].source_path, file.to_string_lossy());
    }

    #[test]
    fn identity() {
        let a = agent();
        assert_eq!(a.id.as_str(), "kimi");
        assert_eq!(a.label, "Kimi CLI");
    }
}
