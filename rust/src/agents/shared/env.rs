//! Port of `src/agents/shared/env.ts`: path environment + root discovery helpers
//! shared by every agent's `roots()`.

use crate::util::{
    app_data_dir, cache_dir, current_platform, expand_home, get_path_env_override, home_dir, is_js_ws,
    local_app_data_dir, path_flavor, PathFlavor,
};

/// VS Code-family product folder names used for User/globalStorage discovery.
const VSCODE_PRODUCT_NAMES: &[&str] = &[
    "Code",
    "Code - Insiders",
    "Code - OSS",
    "VSCodium",
    "Cursor",
    "Cursor - Nightly",
    "Windsurf",
    "Windsurf - Insiders",
    "Trae",
    "Void",
    "Antigravity",
];

/// Resolved directory layout (`pathEnv()` in TS).
#[derive(Debug, Clone)]
pub struct PathEnv {
    pub home: String,
    pub app_data: String,
    pub local_app: String,
    pub cache: String,
    pub xdg_data: String,
    pub xdg_config: String,
    pub xdg_cache: String,
    pub platform: String,
    /// The `path` flavour in effect (override or host).
    pub path: PathFlavor,
}

impl PathEnv {
    /// `path.join(...parts)` with the effective flavour.
    pub fn j(&self, parts: &[&str]) -> String {
        self.path.join(parts)
    }

    /// `expandHome(p)` (override-aware).
    pub fn expand_home(&self, p: &str) -> String {
        expand_home(p)
    }
}

/// `process.env.X` (`??` semantics: only unset falls through, empty string is kept).
fn env_raw(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

pub fn path_env() -> PathEnv {
    let over = get_path_env_override();
    let p = path_flavor();
    let home = over.as_ref().map(|o| o.home.clone()).unwrap_or_else(home_dir);
    let app_data = over.as_ref().map(|o| o.app_data.clone()).unwrap_or_else(app_data_dir);
    let local_app = over.as_ref().map(|o| o.local_app.clone()).unwrap_or_else(local_app_data_dir);
    let cache = over.as_ref().map(|o| o.cache.clone()).unwrap_or_else(cache_dir);
    let xdg_data = over
        .as_ref()
        .map(|o| o.xdg_data.clone())
        .or_else(|| env_raw("XDG_DATA_HOME"))
        .unwrap_or_else(|| p.join(&[home.as_str(), ".local", "share"]));
    let xdg_config = over
        .as_ref()
        .map(|o| o.xdg_config.clone())
        .or_else(|| env_raw("XDG_CONFIG_HOME"))
        .unwrap_or_else(|| p.join(&[home.as_str(), ".config"]));
    let xdg_cache = over
        .as_ref()
        .map(|o| o.xdg_cache.clone())
        .or_else(|| env_raw("XDG_CACHE_HOME"))
        .unwrap_or_else(|| p.join(&[home.as_str(), ".cache"]));
    let platform = current_platform();
    PathEnv { home, app_data, local_app, cache, xdg_data, xdg_config, xdg_cache, platform, path: p }
}

/// `[...new Set(items.filter(Boolean))]` - drop empties and duplicates, keep first-seen order.
pub fn unique<I, S>(items: I) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for s in items {
        let s: String = s.into();
        if s.is_empty() {
            continue;
        }
        if seen.insert(s.clone()) {
            out.push(s);
        }
    }
    out
}

fn collapse_ws_to_dash(s: &str) -> String {
    let mut out = String::new();
    let mut in_ws = false;
    for c in s.chars() {
        if is_js_ws(c) {
            if !in_ws {
                out.push('-');
            }
            in_ws = true;
        } else {
            in_ws = false;
            out.push(c);
        }
    }
    out
}

/// Candidate user-data roots for VS Code family editors on this OS.
pub fn vscode_user_data_roots(extra_products: &[&str]) -> Vec<String> {
    let e = path_env();
    let mut roots: Vec<String> = Vec::new();
    let names = VSCODE_PRODUCT_NAMES.iter().copied().chain(extra_products.iter().copied());
    for name in names {
        roots.push(e.j(&[&e.app_data, name]));
        roots.push(e.j(&[&e.local_app, name]));
        // Linux: also probe XDG paths explicitly.
        if e.platform == "linux" {
            roots.push(e.j(&[&e.xdg_config, name]));
            roots.push(e.j(&[&e.xdg_data, name]));
        }
        // Portable / legacy home folders: `.${name.toLowerCase().replace(/\s+/g, "-")}`
        let dotted = format!(".{}", collapse_ws_to_dash(&name.to_lowercase()));
        roots.push(e.j(&[&e.home, &dotted]));
    }
    unique(roots)
}

/// `User/globalStorage/<extensionId>` paths across all known VS Code forks.
pub fn vscode_global_storage(extension_ids: &[&str]) -> Vec<String> {
    let e = path_env();
    let mut out = Vec::new();
    for root in vscode_user_data_roots(&[]) {
        for id in extension_ids {
            if id.is_empty() {
                continue;
            }
            out.push(e.j(&[&root, "User", "globalStorage", id]));
        }
    }
    unique(out)
}

/// JetBrains config/data roots (Windows / macOS / Linux).
pub fn jetbrains_roots(subpaths: &[&str]) -> Vec<String> {
    let e = path_env();
    let bases = unique(vec![
        e.j(&[&e.app_data, "JetBrains"]),
        e.j(&[&e.local_app, "JetBrains"]),
        e.j(&[&e.xdg_config, "JetBrains"]),
        e.j(&[&e.xdg_data, "JetBrains"]),
        e.j(&[&e.home, "Library", "Application Support", "JetBrains"]),
        e.j(&[&e.home, "Library", "Caches", "JetBrains"]),
    ]);
    if subpaths.is_empty() {
        return bases;
    }
    let mut out = Vec::new();
    for base in &bases {
        for sub in subpaths {
            out.push(e.j(&[base, sub]));
        }
    }
    unique(out)
}

/// `process.env.A || process.env.B || ""` (first non-empty value, else empty string).
pub fn env_chain(names: &[&str]) -> String {
    for n in names {
        if let Some(v) = crate::util::env_nonempty(n) {
            return v;
        }
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::{with_path_env_override, PathEnvOverride};

    #[test]
    fn unique_drops_empty_and_dupes() {
        assert_eq!(unique(vec!["a", "", "b", "a"]), vec!["a", "b"]);
    }

    #[test]
    fn linux_override_roots() {
        let over = PathEnvOverride {
            platform: "linux".into(),
            home: "/home/u".into(),
            app_data: "/home/u/.config".into(),
            local_app: "/home/u/.local/share".into(),
            cache: "/home/u/.cache".into(),
            xdg_data: "/home/u/.local/share".into(),
            xdg_config: "/home/u/.config".into(),
            xdg_cache: "/home/u/.cache".into(),
            path: PathFlavor::Posix,
        };
        let roots = with_path_env_override(over, || vscode_global_storage(&["x.y"]));
        assert!(roots.contains(&"/home/u/.config/Code/User/globalStorage/x.y".to_string()));
        assert!(roots.contains(&"/home/u/.code---insiders/User/globalStorage/x.y".to_string()));
    }
}
