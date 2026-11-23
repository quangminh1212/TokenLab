//! Agent: LiteLLM (port of `src/agents/litellm/index.ts`).

#[allow(unused_imports)]
use crate::agents::shared::env::{env_chain, jetbrains_roots, path_env, unique, vscode_global_storage};
use crate::agents::shared::router_light::parse_router_usage_light;
use crate::agents::shared::router_usage::{parse_router_usage, RouterUsageOptions};
use crate::agents::{parse_fn, AgentModule};
#[allow(unused_imports)]
use crate::util::{app_data_dir, env_nonempty, home_dir, host_platform, js_trim};
use crate::types::AgentId;

/// Local data roots to scan on this machine.
pub fn roots() -> Vec<String> {
    let e = path_env();
    let xlab_data = env_nonempty("TOKENLAB_DATA_DIR").unwrap_or_else(|| e.j(&[&app_data_dir(), "tokenlab"]));
    let mut r: Vec<String> = Vec::new();
    r.push(e.expand_home(&env_chain(&["TOKENLAB_LITELLM_DIR", "LITELLM_HOME"])));
    r.push(e.expand_home(&env_chain(&["LITELLM_DATA_DIR"])));
    r.push(e.j(&[&xlab_data, "mirrors", "litellm"]));
    r.push(e.j(&[&home_dir(), ".tokenlab", "mirrors", "litellm"]));
    r.push(e.j(&[&app_data_dir(), "xlab-token", "mirrors", "litellm"]));
    r.push(e.j(&[&home_dir(), ".xlab-token", "mirrors", "litellm"]));
    if host_platform() == "win32" { r.push("C:\\Dev\\VPS\\my.bnix.one\\litellm\\data".to_string()); }
    r.push(e.j(&[&e.home, "Dev", "VPS", "my.bnix.one", "litellm", "data"]));
    r.push("/opt/litellm/data".to_string());
    r.push(e.j(&[&e.home, ".litellm"]));
    r.push(e.j(&[&e.app_data, "litellm"]));
    r.push(e.j(&[&e.local_app, "litellm"]));
    r.push(e.j(&[&e.xdg_config, "litellm"]));
    r.push(e.j(&[&e.xdg_data, "litellm"]));
    unique(r)
}

pub fn agent() -> AgentModule {
    AgentModule {
        id: AgentId::Litellm,
        label: "LiteLLM",
        roots,
        parse: parse_fn(|roots| async move { parse_router_usage(&roots, AgentId::Litellm, RouterUsageOptions::default()).await }),
        parse_light: Some(parse_fn(|roots| async move { parse_router_usage_light(&roots, AgentId::Litellm).await })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity() {
        let a = agent();
        assert_eq!(a.id.as_str(), "litellm");
        assert_eq!(a.label, "LiteLLM");
    }
}
