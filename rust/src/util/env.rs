//! Platform-aware directories, the path-env override and id helpers.

use super::pathx::PathFlavor;
use crate::types::AgentId;
use sha2::{Digest, Sha256};
use std::cell::RefCell;

/// A temporary path context used to discover data roots on another platform.
#[derive(Debug, Clone)]
pub struct PathEnvOverride {
    /// Node `process.platform` value: "win32" | "darwin" | "linux" | ...
    pub platform: String,
    pub home: String,
    pub app_data: String,
    pub local_app: String,
    pub cache: String,
    pub xdg_data: String,
    pub xdg_config: String,
    pub xdg_cache: String,
    pub path: PathFlavor,
}

thread_local! {
    static PATH_ENV_OVERRIDE: RefCell<Option<PathEnvOverride>> = const { RefCell::new(None) };
}

/// Run a synchronous root-discovery callback with a different OS path layout.
pub fn with_path_env_override<T>(over: PathEnvOverride, f: impl FnOnce() -> T) -> T {
    struct Restore(Option<PathEnvOverride>);
    impl Drop for Restore {
        fn drop(&mut self) {
            let prev = self.0.take();
            PATH_ENV_OVERRIDE.with(|c| *c.borrow_mut() = prev);
        }
    }
    let previous = PATH_ENV_OVERRIDE.with(|c| c.borrow_mut().replace(over));
    let _restore = Restore(previous);
    f()
}

pub fn get_path_env_override() -> Option<PathEnvOverride> {
    PATH_ENV_OVERRIDE.with(|c| c.borrow().clone())
}

/// `process.platform` for the running host.
pub fn host_platform() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "freebsd") {
        "freebsd"
    } else {
        "linux"
    }
}

/// Effective `process.platform` (override-aware where the TS code consults it).
pub fn current_platform() -> String {
    get_path_env_override()
        .map(|o| o.platform)
        .unwrap_or_else(|| host_platform().to_string())
}

/// The `path` flavour in effect (override or host).
pub fn path_flavor() -> PathFlavor {
    get_path_env_override()
        .map(|o| o.path)
        .unwrap_or_else(PathFlavor::host)
}

/// `path.join(...)` with the effective flavour.
pub fn pjoin<S: AsRef<str>>(parts: &[S]) -> String {
    path_flavor().join(parts)
}

/// `process.env[name]` treating empty as unset (JS `||` fallthrough).
pub fn env_nonempty(name: &str) -> Option<String> {
    match std::env::var(name) {
        Ok(v) if !v.is_empty() => Some(v),
        _ => None,
    }
}

pub fn cwd_string() -> String {
    std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| ".".to_string())
}

/// sha256 of the parts joined with "|", hex, first 24 chars.
pub fn stable_id<S: AsRef<str>>(parts: &[S]) -> String {
    let joined = parts.iter().map(|s| s.as_ref()).collect::<Vec<_>>().join("|");
    let digest = Sha256::digest(joined.as_bytes());
    hex::encode(digest)[..24].to_string()
}

/// Canonical agent id for display + aggregation (legacy XLab ids -> routerlab).
pub fn normalize_agent_id(agent: Option<&str>) -> AgentId {
    let a = super::js::js_trim(agent.unwrap_or("")).to_lowercase();
    if a.is_empty() {
        return AgentId::Custom;
    }
    if a == "xlabrouter" || a == "xlrouter" || a == "xlab-router" || a == "xlab_router" {
        return AgentId::Routerlab;
    }
    AgentId::from_id(&a).unwrap_or(AgentId::Custom)
}

/// Same normalisation but keeping unknown ids verbatim (TS `a as AgentId`).
pub fn normalize_agent_id_string(agent: Option<&str>) -> String {
    let a = super::js::js_trim(agent.unwrap_or("")).to_lowercase();
    if a.is_empty() {
        return "custom".to_string();
    }
    if a == "xlabrouter" || a == "xlrouter" || a == "xlab-router" || a == "xlab_router" {
        return "routerlab".to_string();
    }
    a
}

/// Human-facing agent name (dashboard / RECENT EVENTS).
pub fn agent_display_name(agent: Option<&str>) -> String {
    let id = normalize_agent_id_string(agent);
    let label = |k: &str| -> Option<&'static str> {
        Some(match k {
            "routerlab" | "xlabrouter" => "RouterLab",
            "9router" => "9Router",
            "litellm" => "LiteLLM",
            "claude-code" => "Claude Code",
            "dsh" => "DeepSeek Harness",
            "codex" => "OpenAI Codex",
            "cursor" => "Cursor",
            "windsurf" => "Windsurf",
            "grok" => "Grok (xAI)",
            "hermes" => "Hermes Agent",
            "qwencoder" => "QwenCoder Cloud",
            "copilot" => "GitHub Copilot",
            "devin" => "Devin",
            "opencode" => "OpenCode",
            "antigravity" => "Antigravity",
            _ => return None,
        })
    };
    if let Some(l) = label(&id) {
        return l.to_string();
    }
    let raw = agent.unwrap_or("");
    if let Some(l) = label(raw) {
        return l.to_string();
    }
    if raw.is_empty() {
        "unknown".to_string()
    } else {
        raw.to_string()
    }
}

/// User home - platform-aware (USERPROFILE on Windows, HOME on Unix).
pub fn home_dir() -> String {
    if let Some(o) = get_path_env_override() {
        return o.home;
    }
    if cfg!(windows) {
        return env_nonempty("USERPROFILE")
            .or_else(|| env_nonempty("HOME"))
            .unwrap_or_else(cwd_string);
    }
    env_nonempty("HOME")
        .or_else(|| env_nonempty("USERPROFILE"))
        .unwrap_or_else(cwd_string)
}

/// Roaming / config-style application data root.
pub fn app_data_dir() -> String {
    if let Some(o) = get_path_env_override() {
        return o.app_data;
    }
    let home = home_dir();
    match host_platform() {
        "win32" => env_nonempty("APPDATA").unwrap_or_else(|| pjoin(&[&home, "AppData", "Roaming"])),
        "darwin" => pjoin(&[&home, "Library", "Application Support"]),
        _ => env_nonempty("XDG_CONFIG_HOME").unwrap_or_else(|| pjoin(&[&home, ".config"])),
    }
}

/// Local / machine-scoped application data root.
pub fn local_app_data_dir() -> String {
    if let Some(o) = get_path_env_override() {
        return o.local_app;
    }
    let home = home_dir();
    match host_platform() {
        "win32" => env_nonempty("LOCALAPPDATA").unwrap_or_else(|| pjoin(&[&home, "AppData", "Local"])),
        "darwin" => pjoin(&[&home, "Library", "Application Support"]),
        _ => env_nonempty("XDG_DATA_HOME").unwrap_or_else(|| pjoin(&[&home, ".local", "share"])),
    }
}

/// Cache directory root.
pub fn cache_dir() -> String {
    if let Some(o) = get_path_env_override() {
        return o.cache;
    }
    let home = home_dir();
    match host_platform() {
        "win32" => env_nonempty("LOCALAPPDATA").unwrap_or_else(|| pjoin(&[&home, "AppData", "Local"])),
        "darwin" => pjoin(&[&home, "Library", "Caches"]),
        _ => env_nonempty("XDG_CACHE_HOME").unwrap_or_else(|| pjoin(&[&home, ".cache"])),
    }
}

/// Open a URL in the default browser (best-effort, non-blocking).
pub fn open_browser(url: &str) {
    use std::process::{Command, Stdio};
    let mut cmd;
    if cfg!(windows) {
        cmd = Command::new("cmd");
        cmd.args(["/c", "start", "", url]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
    } else if cfg!(target_os = "macos") {
        cmd = Command::new("open");
        cmd.arg(url);
    } else {
        cmd = Command::new("xdg-open");
        cmd.arg(url);
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    // spawn and forget; missing xdg-open / open is ignored
    let _ = cmd.spawn();
}

/// `~` / `~/x` expansion with the effective path flavour.
pub fn expand_home(p: &str) -> String {
    if let Some(o) = get_path_env_override() {
        if p.starts_with("~/") || p == "~" {
            let rest = if p.len() >= 2 { &p[2..] } else { "" };
            return o.path.join(&[o.home.as_str(), rest]);
        }
        return p.to_string();
    }
    if p.starts_with("~/") || p == "~" {
        let rest = if p.len() >= 2 { &p[2..] } else { "" };
        return pjoin(&[home_dir().as_str(), rest]);
    }
    p.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_id_is_24_hex() {
        let id = stable_id(&["a", "b"]);
        assert_eq!(id.len(), 24);
        assert_eq!(id, stable_id(&["a", "b"]));
        assert_ne!(id, stable_id(&["a", "c"]));
        // sha256("a|b") prefix
        assert_eq!(&id[..8], &hex::encode(Sha256::digest(b"a|b"))[..8]);
    }

    #[test]
    fn override_applies_and_restores() {
        let before = home_dir();
        let o = PathEnvOverride {
            platform: "linux".into(),
            home: "/home/x".into(),
            app_data: "/home/x/.config".into(),
            local_app: "/home/x/.local/share".into(),
            cache: "/home/x/.cache".into(),
            xdg_data: "/home/x/.local/share".into(),
            xdg_config: "/home/x/.config".into(),
            xdg_cache: "/home/x/.cache".into(),
            path: PathFlavor::Posix,
        };
        with_path_env_override(o, || {
            assert_eq!(home_dir(), "/home/x");
            assert_eq!(expand_home("~/a"), "/home/x/a");
            assert_eq!(expand_home("~"), "/home/x");
            assert_eq!(current_platform(), "linux");
        });
        assert_eq!(home_dir(), before);
    }

    #[test]
    fn agent_names() {
        assert_eq!(normalize_agent_id(Some(" XLabRouter ")), AgentId::Routerlab);
        assert_eq!(normalize_agent_id(None), AgentId::Custom);
        assert_eq!(agent_display_name(Some("codex")), "OpenAI Codex");
        assert_eq!(agent_display_name(Some("zed")), "zed");
        assert_eq!(agent_display_name(None), "unknown");
    }
}
