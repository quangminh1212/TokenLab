//! Agent: RouterLab (port of `src/agents/xlabrouter/index.ts`).

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
    r.push(e.expand_home(&env_chain(&["TOKENLAB_XLABROUTER_DIR", "TOKENLAB_ROUTERLAB_DIR"])));
    r.push(e.expand_home(&env_chain(&["XLABROUTER_HOME", "XLAB_ROUTER_HOME", "ROUTERLAB_HOME"])));
    r.push(e.expand_home(&env_chain(&["XLABROUTER_DATA_DIR", "ROUTERLAB_DATA_DIR"])));
    r.push(e.j(&[&xlab_data, "mirrors", "routerlab"]));
    r.push(e.j(&[&xlab_data, "mirrors", "xlabrouter"]));
    r.push(e.j(&[&home_dir(), ".tokenlab", "mirrors", "routerlab"]));
    r.push(e.j(&[&home_dir(), ".tokenlab", "mirrors", "xlabrouter"]));
    r.push(e.j(&[&app_data_dir(), "xlab-token", "mirrors", "routerlab"]));
    r.push(e.j(&[&app_data_dir(), "xlab-token", "mirrors", "xlabrouter"]));
    r.push(e.j(&[&home_dir(), ".xlab-token", "mirrors", "routerlab"]));
    r.push(e.j(&[&home_dir(), ".xlab-token", "mirrors", "xlabrouter"]));
    if host_platform() == "win32" { r.push("C:\\Dev\\VPS\\my.bnix.one\\routerlab\\data".to_string()); }
    if host_platform() == "win32" { r.push("C:\\Dev\\VPS\\my.bnix.one\\xlabrouter\\data".to_string()); }
    r.push(e.j(&[&e.home, "Dev", "VPS", "my.bnix.one", "routerlab", "data"]));
    r.push(e.j(&[&e.home, "Dev", "VPS", "my.bnix.one", "xlabrouter", "data"]));
    r.push(e.expand_home(&env_chain(&["DATA_DIR"])));
    r.push("/var/lib/xlabrouter".to_string());
    r.push(e.j(&["/var", "lib", "xlabrouter"]));
    r.push(e.j(&[&e.home, ".xlabrouter"]));
    r.push(e.j(&[&e.home, ".routerlab"]));
    r.push(e.j(&[&e.app_data, "xlabrouter"]));
    r.push(e.j(&[&e.app_data, "routerlab"]));
    r.push(e.j(&[&e.local_app, "xlabrouter"]));
    r.push(e.j(&[&e.local_app, "routerlab"]));
    r.push(e.j(&[&e.xdg_config, "xlabrouter"]));
    r.push(e.j(&[&e.xdg_config, "routerlab"]));
    r.push(e.j(&[&e.xdg_data, "xlabrouter"]));
    r.push(e.j(&[&e.xdg_data, "routerlab"]));
    r.push(e.j(&[&e.app_data, "xlab_router"]));
    r.push(e.j(&[&e.home, ".xlab_router"]));
    unique(r)
}

pub fn agent() -> AgentModule {
    AgentModule {
        id: AgentId::Routerlab,
        label: "RouterLab",
        roots,
        parse: parse_fn(|roots| async move { parse_router_usage(&roots, AgentId::Routerlab, RouterUsageOptions::default()).await }),
        parse_light: Some(parse_fn(|roots| async move { parse_router_usage_light(&roots, AgentId::Routerlab).await })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity() {
        let a = agent();
        assert_eq!(a.id.as_str(), "routerlab");
        assert_eq!(a.label, "RouterLab");
    }
}
