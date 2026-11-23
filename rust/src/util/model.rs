//! Model-name normalisation and token estimation (port of util.ts).

use super::env::normalize_agent_id_string;
use super::js::{js_len, js_trim, JS_WS_CLASS};
use fancy_regex::Regex as FRegex;
use once_cell::sync::Lazy;
use regex::Regex;

fn ws(pattern: &str) -> String {
    // Replace the `@WS@` placeholder with the JS `\s` class body.
    pattern.replace("@WS@", JS_WS_CLASS)
}

fn re(p: &str) -> Regex {
    Regex::new(&ws(p)).unwrap_or_else(|e| panic!("bad regex {p}: {e}"))
}

static RE_PAREN: Lazy<Regex> = Lazy::new(|| re(r"[@WS@]*\([^)]*\)[@WS@]*$"));
static RE_BRACKET: Lazy<Regex> = Lazy::new(|| re(r"[@WS@]*\[[^\]]*\][@WS@]*$"));
static RE_GENERIC_LAST: Lazy<Regex> = Lazy::new(|| re(r"(?i)^(?:models?|v[0-9]+)$"));
static RE_WS_RUN: Lazy<Regex> = Lazy::new(|| re(r"[@WS@]+"));
static RE_DARKAPI: Lazy<Regex> = Lazy::new(|| re(r"(?i)^darkapi(?:$|[-_:|/@WS@])[-_:|/@WS@]*"));
static RE_MINTROUTER: Lazy<Regex> = Lazy::new(|| re(r"(?i)^mintrouter(?:$|[-_:|/@WS@])[-_:|/@WS@]*"));
static RE_OPENAI_COMPACT: Lazy<Regex> = Lazy::new(|| re(r"(?i)-openai-compact$"));
static RE_FREE_BATCH_EXACT: Lazy<Regex> = Lazy::new(|| re(r"(?i)^(?:free|batch)$"));
static RE_FREE_BATCH_SUFFIX: Lazy<Regex> = Lazy::new(|| re(r"(?i)[-_:|/@WS@]+(?:free|batch)$"));
static RE_EFFORT_SUFFIX: Lazy<Regex> =
    Lazy::new(|| re(r"(?i)[-_:|/@WS@]+(?:xhigh|high|low|medium|compact|tiered)$"));
static RE_CLAUDE_THINKING: Lazy<Regex> = Lazy::new(|| re(r"(?i)^claude-(?:opus|sonnet|haiku)-.+-thinking$"));
static RE_THINKING_SUFFIX: Lazy<Regex> = Lazy::new(|| re(r"(?i)-thinking$"));
static RE_SWE_MODE: Lazy<Regex> = Lazy::new(|| re(r"(?i)^swe-[0-9]+(?:[-.][0-9]+)?-(?:fast|slow)$"));
static RE_SWE_MODE_SUFFIX: Lazy<Regex> = Lazy::new(|| re(r"(?i)-(?:fast|slow)$"));
static RE_CLAUDE_DOUBLE_VER: Lazy<Regex> =
    Lazy::new(|| re(r"(?i)^(claude-(?:opus|sonnet|haiku)-[0-9]+\.[0-9]+)(?:-[0-9]+\.[0-9]+)+$"));
static RE_CLAUDE_DASH_VER: Lazy<Regex> =
    Lazy::new(|| re(r"(?i)^(claude-(?:opus|sonnet|haiku)-[0-9]+)-([0-9]+)$"));
static RE_GPT_CODENAME: Lazy<Regex> = Lazy::new(|| re(r"(?i)^(gpt-[0-9]+)-([0-9]+)-(luna|sol|terra)$"));
static RE_GLM_SWE: Lazy<Regex> = Lazy::new(|| re(r"(?i)^(glm|swe)-([0-9]+)-([0-9]+)$"));
static RE_DASH_5_2: Lazy<FRegex> = Lazy::new(|| FRegex::new(r"-5-2(?![0-9])").unwrap());
static RE_GLM_DOT0: Lazy<Regex> = Lazy::new(|| re(r"(?i)^glm-([0-9]+)\.0$"));
static RE_GEMINI_31_PRO: Lazy<Regex> = Lazy::new(|| re(r"(?i)^gemini-3\.1-pro$"));
static RE_GROK_BUILD: Lazy<Regex> = Lazy::new(|| re(r"(?i)^(grok-[0-9]+\.[0-9]+)-build$"));
static RE_CLAUDE_LITE: Lazy<Regex> = Lazy::new(|| re(r"(?i)^(claude-(?:opus|sonnet|haiku)-.+)-lite$"));
static RE_PMV_OPUS: Lazy<Regex> = Lazy::new(|| re(r"(?i)^pmv-opus-([0-9]+\.[0-9]+)$"));
static RE_TRAIL_SEP: Lazy<Regex> = Lazy::new(|| re(r"[-_:|]+$"));
static RE_FABLE_FLASH: Lazy<Regex> =
    Lazy::new(|| re(r"^(?:claude[- ]fable[- ]3\.7[- ]flash|gemini[- ]3\.7[- ]flash)$"));
static RE_KIMI_26: Lazy<Regex> = Lazy::new(|| re(r"^kimi[- ](?:k2[-.]6|2\.6)(?:[- ]code)?$"));
static RE_KIMI_27: Lazy<Regex> = Lazy::new(|| re(r"^kimi[- ](?:k2[-.]7|2\.7)(?:[- ]code)?$"));
static RE_QWENCODER_MAX: Lazy<Regex> = Lazy::new(|| re(r"^qwencoder[- ]qwen3\.8[- ]max$"));

const OFFICIAL_OPENROUTER_HIGH_MODEL_IDS: [&str; 2] = ["o3-mini-high", "o4-mini-high"];
// These labels describe a source or incomplete usage row, not a model ID.
const NON_MODEL_USAGE_LABELS: [&str; 9] = [
    "unknown",
    "9router-usage-backup",
    "9router-daily-summary",
    "9router-api-chart",
    "mixed",
    "default",
    "gpt",
    "qwencoder",
    "unattributed",
];

fn rep(re: &Regex, s: &str, with: &str) -> String {
    re.replace_all(s, with).into_owned()
}

/// Normalize model display/group keys so variants collapse together.
pub fn normalize_model_name(model: Option<&str>) -> Option<String> {
    let model = model?;
    let mut m = js_trim(model).to_string();
    if m.is_empty() {
        return None;
    }

    // Strip parenthetical provider/connection suffixes, up to 3 times.
    for _ in 0..3 {
        let next = js_trim(&rep(&RE_PAREN, &m, "")).to_string();
        if next == m {
            break;
        }
        m = next;
    }

    // Strip bracket suffixes: "name [conn]"
    m = js_trim(&rep(&RE_BRACKET, &m, "")).to_string();

    // Router daily keys: "rawModel|providerId"
    if m.contains('|') {
        m = js_trim(m.split('|').next().unwrap_or("")).to_string();
    }

    // "provider/model" -> last segment when it looks like a model id
    if m.contains('/') && !m.starts_with("http") {
        let parts: Vec<&str> = m.split('/').map(js_trim).filter(|p| !p.is_empty()).collect();
        let last: String = parts.last().map(|s| s.to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| m.clone());
        if !last.is_empty() && js_len(&last) >= 2 && !RE_GENERIC_LAST.is_match(&last) {
            m = last;
        }
    }

    // Collapse internal whitespace
    m = js_trim(&rep(&RE_WS_RUN, &m, " ")).to_string();
    // DarkAPI is the gateway/provider label, not part of the public model name.
    m = rep(&RE_DARKAPI, &m, "");

    m = rep(&RE_MINTROUTER, &m, "");
    m = rep(&RE_OPENAI_COMPACT, &m, "");
    if !RE_FREE_BATCH_EXACT.is_match(&m) {
        m = rep(&RE_FREE_BATCH_SUFFIX, &m, "");
    }

    // A few official OpenRouter IDs really do end in `-high`.
    if !OFFICIAL_OPENROUTER_HIGH_MODEL_IDS.contains(&m.to_lowercase().as_str()) {
        m = rep(&RE_EFFORT_SUFFIX, &m, "");
    }
    if RE_CLAUDE_THINKING.is_match(&m) {
        m = rep(&RE_THINKING_SUFFIX, &m, "");
    }
    if RE_SWE_MODE.is_match(&m) {
        m = rep(&RE_SWE_MODE_SUFFIX, &m, "");
    }

    // Repair observed aliases that differ from OpenRouter's stable model IDs.
    m = rep(&RE_CLAUDE_DOUBLE_VER, &m, "${1}");
    m = rep(&RE_CLAUDE_DASH_VER, &m, "${1}.${2}");
    m = rep(&RE_GPT_CODENAME, &m, "${1}.${2}-${3}");
    m = rep(&RE_GLM_SWE, &m, "${1}-${2}.${3}");
    // Slugs write 5.2 as 5-2. Keep the decimal.
    m = RE_DASH_5_2.replace_all(&m, "-5.2").into_owned();
    m = rep(&RE_GLM_DOT0, &m, "glm-${1}");
    m = rep(&RE_GEMINI_31_PRO, &m, "gemini-3.1-pro-preview");
    m = rep(&RE_GROK_BUILD, &m, "${1}");
    m = rep(&RE_CLAUDE_LITE, &m, "${1}");
    m = rep(&RE_PMV_OPUS, &m, "claude-opus-${1}");
    if NON_MODEL_USAGE_LABELS.contains(&m.to_lowercase().as_str()) {
        return None;
    }

    // Drop trailing separators
    m = js_trim(&rep(&RE_TRAIL_SEP, &m, "")).to_string();

    // Common vendor spelling variants -> canonical form for grouping + rates
    let lower = m.to_lowercase();
    let l = lower.as_str();
    if l == "deepseek-chat" {
        m = "deepseek-v4-flash".into();
    } else if RE_FABLE_FLASH.is_match(l) {
        m = "gemini-3.8-flash".into();
    } else if RE_KIMI_26.is_match(l) {
        m = "kimi-k2.6".into();
    } else if RE_KIMI_27.is_match(l) {
        m = "kimi-k2.7".into();
    } else if l == "mimo-auto" {
        m = "mimo-v2.5".into();
    } else if l == "model_private_11" {
        m = "big-pickle".into();
    } else if l == "vip-kimi" {
        m = "kimi-k3".into();
    } else if l == "swe-agent" || l == "swe agent" {
        m = "swe-1.6".into();
    } else if l == "windsurf-cascade" {
        m = "swe-1.6".into();
    } else if l == "xlab" {
        m = "gpt-5.5".into();
    } else if l == "gpt-5.3-codex" {
        m = "gpt-5.5".into();
    } else if l == "gp-gpt-5.5" {
        m = "gpt-5.5".into();
    } else if l == "claude-fable" {
        m = "claude-fable-5".into();
    } else if l == "pmv-default" {
        m = "claude-fable-5".into();
    } else if l == "claude-opus" {
        m = "claude-opus-5.5".into();
    } else if l == "claude-sonnet" {
        m = "claude-sonnet-5.5".into();
    } else if l == "digigo" {
        m = "gpt-5.5".into();
    } else if RE_QWENCODER_MAX.is_match(l) {
        m = "qwen3.8 max".into();
    } else if l == "free" {
        m = "big-pickle".into();
    }
    if l.starts_with("deep-seek") {
        m = format!("deepseek{}", m.chars().skip("deep-seek".len()).collect::<String>());
    }
    if l.starts_with("deep_seek") {
        m = format!("deepseek{}", m.chars().skip("deep_seek".len()).collect::<String>());
    }
    // LiteLLM internal alias for the openclaw 5.3 route.
    if l == "openclaw" {
        m = "glm-5.3".into();
    }

    if m.is_empty() {
        None
    } else {
        Some(m)
    }
}

/// Apply a fallback only when the agent identifies one unambiguous model.
pub fn normalize_model_for_agent(model: Option<&str>, agent: Option<&str>) -> Option<String> {
    if let Some(n) = normalize_model_name(model) {
        return Some(n);
    }
    match normalize_agent_id_string(agent).as_str() {
        "devin" | "swe-agent" | "swe agent" => Some("swe-1.6".to_string()),
        _ => None,
    }
}

/// ~4 chars per token heuristic for text (UTF-16 length like JS).
pub fn estimate_tokens_from_text(text: &str) -> f64 {
    if text.is_empty() {
        return 0.0;
    }
    estimate_tokens_from_chars(js_len(text) as f64)
}

/// Same heuristic from a character/byte count.
pub fn estimate_tokens_from_chars(char_count: f64) -> f64 {
    let n = if char_count.is_nan() { 0.0 } else { char_count };
    if n <= 0.0 {
        return 0.0;
    }
    (n / 4.0).ceil().max(1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(s: &str) -> Option<String> {
        normalize_model_name(Some(s))
    }

    #[test]
    fn strips_wrappers() {
        assert_eq!(n("gpt-5.5 (openai-compatible-responses-uuid)").as_deref(), Some("gpt-5.5"));
        assert_eq!(n("gpt-5.5|provider-id").as_deref(), Some("gpt-5.5"));
        assert_eq!(n("openai/gpt-4.1").as_deref(), Some("gpt-4.1"));
        assert_eq!(n("  claude-sonnet-4 [conn] ").as_deref(), Some("claude-sonnet-4"));
        assert_eq!(n("DarkAPI-gpt-5.5").as_deref(), Some("gpt-5.5"));
        assert_eq!(n("").as_deref(), None);
        assert_eq!(normalize_model_name(None), None);
    }

    #[test]
    fn suffixes_and_aliases() {
        assert_eq!(n("gpt-5.5-xhigh").as_deref(), Some("gpt-5.5"));
        assert_eq!(n("o3-mini-high").as_deref(), Some("o3-mini-high"));
        assert_eq!(n("claude-sonnet-4-5").as_deref(), Some("claude-sonnet-4.5"));
        assert_eq!(n("claude-opus-4.5-thinking").as_deref(), Some("claude-opus-4.5"));
        assert_eq!(n("claude-fable-5-2").as_deref(), Some("claude-fable-5.2"));
        assert_eq!(n("gpt-5-2").as_deref(), Some("gpt-5.2"));
        assert_eq!(n("glm-5-1").as_deref(), Some("glm-5.1"));
        assert_eq!(n("glm-5.0").as_deref(), Some("glm-5"));
        assert_eq!(n("deepseek-chat").as_deref(), Some("deepseek-v4-flash"));
        assert_eq!(n("deep-seek-v3").as_deref(), Some("deepseek-v3"));
        assert_eq!(n("kimi k2.6 code").as_deref(), Some("kimi-k2.6"));
        assert_eq!(n("openclaw").as_deref(), Some("glm-5.3"));
        assert_eq!(n("free").as_deref(), Some("big-pickle"));
        assert_eq!(n("gemini-3.1-pro").as_deref(), Some("gemini-3.1-pro-preview"));
    }

    #[test]
    fn non_model_labels_drop() {
        assert_eq!(n("unknown"), None);
        assert_eq!(n("Mixed"), None);
        assert_eq!(n("9router-usage-backup"), None);
    }

    #[test]
    fn agent_fallback() {
        assert_eq!(normalize_model_for_agent(None, Some("devin")).as_deref(), Some("swe-1.6"));
        assert_eq!(normalize_model_for_agent(None, Some("codex")), None);
        assert_eq!(normalize_model_for_agent(Some("gpt-5.5"), Some("devin")).as_deref(), Some("gpt-5.5"));
    }

    #[test]
    fn token_estimates() {
        assert_eq!(estimate_tokens_from_text(""), 0.0);
        assert_eq!(estimate_tokens_from_text("abcd"), 1.0);
        assert_eq!(estimate_tokens_from_text("abcde"), 2.0);
        assert_eq!(estimate_tokens_from_chars(0.0), 0.0);
        assert_eq!(estimate_tokens_from_chars(1.0), 1.0);
    }
}
