//! Port of `src/rate-guard.ts`.
//!
//! Request-rate guard that mirrors LiteLLM's own pre-call limiter
//! (`glm_rps_limit.py`, recovered from bytecode):
//!
//! 1. Sliding windows over individual request start times (not calendar buckets).
//! 2. Monotonic clock: callers pass elapsed *seconds*, never wall-clock stamps.
//! 3. `>=` on the limit, so a limit of N rejects the (N+1)th request in the window.
//! 4. `max(1, ceil(...))` Retry-After, never 0 or a fraction.
//!
//! A rejected request is NOT recorded, so a client that retries right after a
//! 429 gets a fresh evaluation instead of deepening its own penalty.

use crate::types::jsnum;
use crate::util::{js_num_to_string, js_number_from_str, js_trim};
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// A single window/limit pair, matching one branch of the upstream guard.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateWindow {
    /// Bucket identifier, e.g. 1 ("1s") or 60 ("60s").
    #[serde(with = "jsnum")]
    pub window_seconds: f64,
    /// Requests allowed inside `window_seconds`. The check is `>=`, so this is exclusive.
    #[serde(with = "jsnum")]
    pub limit: f64,
}

/// Limits for one model route, mirroring the upstream module-level constants.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitSpec {
    /// Model ids this spec applies to, compared lowercased+trimmed. Empty = all.
    pub models: Vec<String>,
    pub windows: Vec<RateWindow>,
}

/// Which window rejected a request.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectedBy {
    #[serde(with = "jsnum")]
    pub window_seconds: f64,
    #[serde(with = "jsnum")]
    pub limit: f64,
}

/// Requests currently inside one window.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowCount {
    #[serde(with = "jsnum")]
    pub window_seconds: f64,
    #[serde(with = "jsnum")]
    pub limit: f64,
    #[serde(with = "jsnum")]
    pub count: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateVerdict {
    pub allowed: bool,
    /// Which window rejected the request, when denied.
    pub rejected_by: Option<RejectedBy>,
    /// Seconds to wait before retrying. `max(1, ceil(...))`, like upstream.
    #[serde(serialize_with = "jsnum::ser_opt", deserialize_with = "jsnum::de_opt")]
    pub retry_after_seconds: Option<f64>,
    /// Requests currently inside each window — the numbers upstream compares.
    pub counts: Vec<WindowCount>,
    /// Human-readable message shaped like the upstream ProxyRateLimitError detail.
    pub message: Option<String>,
}

/// Upstream defaults, straight from the recovered constants.
pub const LITELLM_RPS_LIMIT: f64 = 1.0;
pub const LITELLM_RPM_LIMIT: f64 = 60.0;
pub const LITELLM_SECOND_WINDOW_SECONDS: f64 = 1.0;
pub const LITELLM_MINUTE_WINDOW_SECONDS: f64 = 60.0;

/// The model ids the upstream callback gated (`GLM_MODELS`).
pub const LITELLM_GATED_MODELS: [&str; 2] = ["glm-5.3", "glm-5.53"];

/// Recovered upstream configuration: 1 req/s and 60 req/min, GLM routes only.
pub fn litellm_default_spec() -> RateLimitSpec {
    RateLimitSpec {
        models: LITELLM_GATED_MODELS.iter().map(|s| s.to_string()).collect(),
        windows: vec![
            RateWindow { window_seconds: LITELLM_SECOND_WINDOW_SECONDS, limit: LITELLM_RPS_LIMIT },
            RateWindow { window_seconds: LITELLM_MINUTE_WINDOW_SECONDS, limit: LITELLM_RPM_LIMIT },
        ],
    }
}

static RE_WINDOW: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^([0-9]+(?:\.[0-9]+)?)\s*/\s*([0-9]+(?:\.[0-9]+)?)\s*(s|m|h)?$").unwrap());

/// Parse `RATE_LIMIT_WINDOWS` style config, e.g. "5/30s,2/1s" or "1/1s,60/60s".
pub fn parse_rate_windows(raw: Option<&str>) -> Option<Vec<RateWindow>> {
    let raw = raw?;
    if raw.is_empty() || js_trim(raw).is_empty() {
        return None;
    }
    let mut out: Vec<RateWindow> = Vec::new();
    for part in raw.split(',') {
        let piece = js_trim(part);
        if piece.is_empty() {
            continue;
        }
        // Accepted: "5/30s", "5/30", "5 / 30s"
        let m = RE_WINDOW.captures(piece)?;
        let limit = js_number_from_str(&m[1]);
        let mut window_seconds = js_number_from_str(&m[2]);
        if !limit.is_finite() || !window_seconds.is_finite() {
            return None;
        }
        let unit = m.get(3).map(|u| u.as_str().to_lowercase()).unwrap_or_else(|| "s".to_string());
        if unit == "m" {
            window_seconds *= 60.0;
        } else if unit == "h" {
            window_seconds *= 3600.0;
        }
        if limit <= 0.0 || window_seconds <= 0.0 {
            return None;
        }
        out.push(RateWindow { window_seconds, limit });
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn is_model_id_char(c: char) -> bool {
    c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | ':' | '/' | '+' | '@' | '-')
}

/// Parse `RATE_LIMIT_MODELS` list, e.g. "glm-5.3,glm-5.53" or "*" for all.
///
/// Returns `None` for anything that cannot be a model list, so the caller can
/// warn and fall back instead of installing a guard that matches nothing.
/// Every entry must use only letters, digits and `. _ - : / + @`, AND contain at
/// least one letter or digit. `"*"` yields an empty list (= all models).
pub fn parse_rate_models(raw: Option<&str>) -> Option<Vec<String>> {
    let raw = raw?;
    let trimmed = js_trim(raw);
    if trimmed.is_empty() {
        return None;
    }
    if trimmed == "*" {
        return Some(Vec::new());
    }
    let models: Vec<String> = trimmed
        .split(',')
        .map(|m| js_trim(m).to_lowercase())
        .filter(|m| !m.is_empty())
        .collect();
    if models.is_empty() {
        return None;
    }
    let ok = models
        .iter()
        .all(|m| m.chars().all(is_model_id_char) && m.chars().any(|c| c.is_ascii_lowercase() || c.is_ascii_digit()));
    if !ok {
        return None;
    }
    Some(models)
}

/// Rolling-window request guard, ported from LiteLLM's pre-call hook.
///
/// State is intentionally process-local and per-model, exactly like upstream:
/// the deque holds start offsets in seconds and is pruned by the widest window.
#[derive(Debug, Clone)]
pub struct RequestRateGuard {
    starts: Vec<f64>,
    windows: Vec<RateWindow>,
    models: HashSet<String>,
    widest_window_seconds: f64,
}

fn lower_trim(s: &str) -> String {
    js_trim(s).to_lowercase()
}

fn js_ceil_max1(x: f64) -> f64 {
    x.ceil().max(1.0)
}

impl RequestRateGuard {
    pub fn new(spec: &RateLimitSpec) -> Self {
        let mut windows = spec.windows.clone();
        // Stable sort, like Array.prototype.sort.
        windows.sort_by(|a, b| a.window_seconds.partial_cmp(&b.window_seconds).unwrap_or(std::cmp::Ordering::Equal));
        let models: HashSet<String> = spec.models.iter().map(|m| lower_trim(m)).collect();
        let widest = windows.iter().fold(0.0_f64, |max, w| max.max(w.window_seconds));
        RequestRateGuard { starts: Vec::new(), windows, models, widest_window_seconds: widest }
    }

    /// True when this guard gates the given model id. Empty model set = all.
    pub fn applies_to(&self, model: Option<&str>) -> bool {
        if self.models.is_empty() {
            return true;
        }
        match model {
            None => false,
            Some(m) => self.models.contains(&lower_trim(m)),
        }
    }

    /// Current request count inside each window. Prunes stale entries first.
    pub fn counts_at(&mut self, now_seconds: f64) -> Vec<WindowCount> {
        self.prune(now_seconds);
        self.windows
            .iter()
            .map(|w| WindowCount {
                window_seconds: w.window_seconds,
                limit: w.limit,
                count: self.starts.iter().filter(|t| now_seconds - **t < w.window_seconds).count() as f64,
            })
            .collect()
    }

    /// Prune entries older than the widest window — upstream's `while` + `popleft`.
    fn prune(&mut self, now_seconds: f64) {
        // The deque is append-ordered, so stale entries are always a prefix.
        let mut drop = 0;
        while drop < self.starts.len() && now_seconds - self.starts[drop] >= self.widest_window_seconds {
            drop += 1;
        }
        if drop > 0 {
            self.starts.drain(..drop);
        }
    }

    /// Evaluate a request without recording it. Mirrors the upstream order:
    /// narrowest window first, then widest, first failure wins.
    pub fn check(&mut self, model: Option<&str>, now_seconds: f64) -> RateVerdict {
        if !self.applies_to(model) {
            return RateVerdict { allowed: true, rejected_by: None, retry_after_seconds: None, counts: Vec::new(), message: None };
        }

        self.prune(now_seconds);
        let label = model.map(lower_trim).unwrap_or_default();
        let mut counts: Vec<WindowCount> = Vec::new();

        for w in &self.windows {
            let inside: Vec<f64> = self.starts.iter().copied().filter(|t| now_seconds - *t < w.window_seconds).collect();
            counts.push(WindowCount { window_seconds: w.window_seconds, limit: w.limit, count: inside.len() as f64 });
            if inside.len() as f64 >= w.limit {
                // Upstream: max(1, ceil(window - (now - oldest_in_window)))
                let oldest = inside[0];
                let retry_after_seconds = js_ceil_max1(w.window_seconds - (now_seconds - oldest));
                let unit = if w.window_seconds < 60.0 { "per second" } else { "per minute" };
                let per_unit = format!("maximum {} requests {}", js_num_to_string(w.limit), unit);
                return RateVerdict {
                    allowed: false,
                    rejected_by: Some(RejectedBy { window_seconds: w.window_seconds, limit: w.limit }),
                    retry_after_seconds: Some(retry_after_seconds),
                    counts,
                    message: Some(format!("{label} rate limit exceeded: {per_unit}")),
                };
            }
        }

        RateVerdict { allowed: true, rejected_by: None, retry_after_seconds: None, counts, message: None }
    }

    /// Check and, when allowed, record the request — the guard's normal entry
    /// point. A denied request is never recorded, matching upstream: rejection
    /// must not extend the window.
    pub fn admit(&mut self, model: Option<&str>, now_seconds: f64) -> RateVerdict {
        let verdict = self.check(model, now_seconds);
        if verdict.allowed && self.applies_to(model) {
            self.starts.push(now_seconds);
        }
        verdict
    }

    /// Drop all state (model switch, config reload, tests).
    pub fn reset(&mut self) {
        self.starts.clear();
    }

    /// Requests currently held in state — after pruning, the widest window's count.
    pub fn size(&mut self, now_seconds: f64) -> usize {
        self.prune(now_seconds);
        self.starts.len()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayDecision {
    #[serde(with = "jsnum")]
    pub index: f64,
    #[serde(with = "jsnum")]
    pub at_seconds: f64,
    pub allowed: bool,
    #[serde(serialize_with = "jsnum::ser_opt", deserialize_with = "jsnum::de_opt")]
    pub retry_after_seconds: Option<f64>,
    pub rejected_by: Option<RejectedBy>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayResult {
    pub decisions: Vec<ReplayDecision>,
    #[serde(with = "jsnum")]
    pub admitted: f64,
    #[serde(with = "jsnum")]
    pub rejected: f64,
    /// First admitted timestamp (seconds), for caller context.
    #[serde(serialize_with = "jsnum::ser_opt", deserialize_with = "jsnum::de_opt")]
    pub first_admission_at_seconds: Option<f64>,
}

/// Feed recorded request timestamps through the guard and report each verdict.
///
/// This is how TokenLab answers "would LiteLLM have rejected this?" without
/// touching the proxy. `timestamps_seconds` must be ascending; non-finite values
/// are skipped (but still advance the decision `index`).
pub fn replay_through_guard(spec: &RateLimitSpec, model: Option<&str>, timestamps_seconds: &[f64]) -> ReplayResult {
    let mut guard = RequestRateGuard::new(spec);
    let mut decisions: Vec<ReplayDecision> = Vec::new();
    let mut admitted = 0.0;
    let mut rejected = 0.0;
    let mut first_admission_at_seconds: Option<f64> = None;

    for (i, &at) in timestamps_seconds.iter().enumerate() {
        if !at.is_finite() {
            continue;
        }
        let verdict = guard.admit(model, at);
        if verdict.allowed {
            admitted += 1.0;
            if first_admission_at_seconds.is_none() {
                first_admission_at_seconds = Some(at);
            }
        } else {
            rejected += 1.0;
        }
        decisions.push(ReplayDecision {
            index: i as f64,
            at_seconds: at,
            allowed: verdict.allowed,
            retry_after_seconds: verdict.retry_after_seconds,
            rejected_by: verdict.rejected_by,
        });
    }

    ReplayResult { decisions, admitted, rejected, first_admission_at_seconds }
}

/// Inputs for [`resolve_rate_spec`] (env > config > upstream default).
#[derive(Debug, Clone, Default)]
pub struct RateConfigInput {
    /// `config.rateLimit.windows`, e.g. "5/30s,2/1s".
    pub config_windows: Option<String>,
    /// `config.rateLimit.models`, e.g. "glm-5.3" or "*".
    pub config_models: Option<String>,
    /// Environment, injected so this stays testable. `None` = the process env.
    pub env: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RateSpecSource {
    #[serde(rename = "env")]
    Env,
    #[serde(rename = "config")]
    Config,
    #[serde(rename = "upstream-default")]
    UpstreamDefault,
}

impl RateSpecSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            RateSpecSource::Env => "env",
            RateSpecSource::Config => "config",
            RateSpecSource::UpstreamDefault => "upstream-default",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedRateSpec {
    pub spec: RateLimitSpec,
    /// Where the window list came from, for the API/UI to show provenance.
    pub windows_source: RateSpecSource,
    pub models_source: RateSpecSource,
    /// Non-fatal problems (unparseable override fell back to the default).
    pub warnings: Vec<String>,
    /// True when nothing overrode the recovered upstream constants.
    pub is_upstream_default: bool,
}

fn json_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| format!("\"{s}\""))
}

/// Resolve the effective guard spec from env > config > upstream default.
///
/// Precedence is deliberate: an operator debugging a live block wants an env
/// override to take effect immediately, without editing config.json. A
/// malformed override is reported in `warnings` rather than silently ignored.
pub fn resolve_rate_spec(input: &RateConfigInput) -> ResolvedRateSpec {
    let get_env = |name: &str| -> Option<String> {
        match &input.env {
            Some(m) => m.get(name).cloned(),
            None => std::env::var(name).ok(),
        }
    };
    let mut warnings: Vec<String> = Vec::new();

    let env_windows = get_env("TOKENLAB_RATE_LIMIT_WINDOWS");
    let cfg_windows = input.config_windows.clone();

    let mut windows: Option<Vec<RateWindow>> = None;
    let mut windows_source = RateSpecSource::UpstreamDefault;

    if let Some(ew) = env_windows.as_deref() {
        if !js_trim(ew).is_empty() {
            windows = parse_rate_windows(Some(ew));
            if windows.is_some() {
                windows_source = RateSpecSource::Env;
            } else {
                warnings.push(format!("TOKENLAB_RATE_LIMIT_WINDOWS={} is not parseable; using default", json_str(ew)));
            }
        }
    }
    if windows.is_none() {
        if let Some(cw) = cfg_windows.as_deref() {
            if !js_trim(cw).is_empty() {
                windows = parse_rate_windows(Some(cw));
                if windows.is_some() {
                    windows_source = RateSpecSource::Config;
                } else {
                    warnings.push(format!("config rateLimit.windows={} is not parseable; using default", json_str(cw)));
                }
            }
        }
    }
    let windows = match windows {
        Some(w) => w,
        None => {
            windows_source = RateSpecSource::UpstreamDefault;
            litellm_default_spec().windows
        }
    };

    let env_models = get_env("TOKENLAB_RATE_LIMIT_MODELS");
    let cfg_models = input.config_models.clone();

    let mut models: Option<Vec<String>> = None;
    let mut models_source = RateSpecSource::UpstreamDefault;

    if let Some(em) = env_models.as_deref() {
        if !js_trim(em).is_empty() {
            models = parse_rate_models(Some(em));
            if models.is_some() {
                models_source = RateSpecSource::Env;
            } else {
                warnings.push(format!("TOKENLAB_RATE_LIMIT_MODELS={} is not parseable; using default", json_str(em)));
            }
        }
    }
    if models.is_none() {
        if let Some(cm) = cfg_models.as_deref() {
            if !js_trim(cm).is_empty() {
                models = parse_rate_models(Some(cm));
                if models.is_some() {
                    models_source = RateSpecSource::Config;
                } else {
                    warnings.push(format!("config rateLimit.models={} is not parseable; using default", json_str(cm)));
                }
            }
        }
    }
    let models = match models {
        Some(m) => m,
        None => {
            models_source = RateSpecSource::UpstreamDefault;
            litellm_default_spec().models
        }
    };

    ResolvedRateSpec {
        spec: RateLimitSpec { models, windows },
        windows_source,
        models_source,
        warnings,
        is_upstream_default: windows_source == RateSpecSource::UpstreamDefault
            && models_source == RateSpecSource::UpstreamDefault,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec_all(windows: &[(f64, f64)]) -> RateLimitSpec {
        RateLimitSpec {
            models: vec![],
            windows: windows.iter().map(|&(w, l)| RateWindow { window_seconds: w, limit: l }).collect(),
        }
    }

    #[test]
    fn parses_windows() {
        let w = parse_rate_windows(Some("5/30s, 2 / 1")).unwrap();
        assert_eq!(w, vec![RateWindow { window_seconds: 30.0, limit: 5.0 }, RateWindow { window_seconds: 1.0, limit: 2.0 }]);
        assert_eq!(parse_rate_windows(Some("1/2m")).unwrap()[0].window_seconds, 120.0);
        assert_eq!(parse_rate_windows(Some("1/1h")).unwrap()[0].window_seconds, 3600.0);
        assert!(parse_rate_windows(Some("0/1s")).is_none());
        assert!(parse_rate_windows(Some("abc")).is_none());
        assert!(parse_rate_windows(Some("  ")).is_none());
        assert!(parse_rate_windows(Some(",,")).is_none());
        assert!(parse_rate_windows(None).is_none());
    }

    #[test]
    fn parses_models() {
        assert_eq!(parse_rate_models(Some("*")), Some(vec![]));
        assert_eq!(parse_rate_models(Some("GLM-5.3, glm-5.53")), Some(vec!["glm-5.3".into(), "glm-5.53".into()]));
        assert_eq!(
            parse_rate_models(Some("nvidia/nemotron-3-ultra-550b-a55b:free")),
            Some(vec!["nvidia/nemotron-3-ultra-550b-a55b:free".into()])
        );
        assert!(parse_rate_models(Some("@@@")).is_none());
        assert!(parse_rate_models(Some("!!!bad!!!")).is_none());
        assert!(parse_rate_models(Some(" , ")).is_none());
        assert!(parse_rate_models(None).is_none());
    }

    #[test]
    fn exclusive_limit_and_retry_after() {
        let spec = litellm_default_spec();
        let mut g = RequestRateGuard::new(&spec);
        assert!(g.admit(Some("glm-5.3"), 0.0).allowed);
        let v = g.admit(Some("glm-5.3"), 0.25);
        assert!(!v.allowed);
        assert_eq!(v.retry_after_seconds, Some(1.0));
        assert_eq!(v.rejected_by, Some(RejectedBy { window_seconds: 1.0, limit: 1.0 }));
        assert_eq!(v.message.as_deref(), Some("glm-5.3 rate limit exceeded: maximum 1 requests per second"));
        // Rejected request was not recorded: at t=1.0 the first has aged out.
        assert!(g.admit(Some("glm-5.3"), 1.0).allowed);
        // Ungated model passes with no counts.
        let v = g.admit(Some("gpt-4o"), 1.0);
        assert!(v.allowed && v.counts.is_empty());
    }

    #[test]
    fn minute_window_rejects_sixty_first() {
        let spec = spec_all(&[(60.0, 60.0)]);
        let mut g = RequestRateGuard::new(&spec);
        for i in 0..60 {
            assert!(g.admit(Some("x"), i as f64 * 0.5).allowed, "{i}");
        }
        let v = g.admit(Some("x"), 29.5);
        assert!(!v.allowed);
        assert_eq!(v.retry_after_seconds, Some(31.0));
        assert_eq!(v.message.as_deref(), Some("x rate limit exceeded: maximum 60 requests per minute"));
    }

    #[test]
    fn replay_counts() {
        let spec = spec_all(&[(1.0, 1.0)]);
        let r = replay_through_guard(&spec, Some("m"), &[0.0, 0.5, f64::NAN, 1.0, 1.2]);
        assert_eq!(r.admitted, 2.0);
        assert_eq!(r.rejected, 2.0);
        assert_eq!(r.first_admission_at_seconds, Some(0.0));
        assert_eq!(r.decisions.len(), 4);
        assert_eq!(r.decisions[2].index, 3.0);
        let j = serde_json::to_value(&r).unwrap();
        assert_eq!(j["decisions"][1]["rejectedBy"]["windowSeconds"], 1);
        assert!(j["decisions"][0]["rejectedBy"].is_null());
    }

    #[test]
    fn resolves_precedence() {
        let mut env = HashMap::new();
        env.insert("TOKENLAB_RATE_LIMIT_WINDOWS".to_string(), "bogus".to_string());
        let r = resolve_rate_spec(&RateConfigInput {
            config_windows: Some("5/30s".into()),
            config_models: Some("*".into()),
            env: Some(env),
        });
        assert_eq!(r.windows_source, RateSpecSource::Config);
        assert_eq!(r.models_source, RateSpecSource::Config);
        assert_eq!(r.spec.windows[0].limit, 5.0);
        assert!(r.spec.models.is_empty());
        assert_eq!(r.warnings, vec!["TOKENLAB_RATE_LIMIT_WINDOWS=\"bogus\" is not parseable; using default".to_string()]);
        assert!(!r.is_upstream_default);
        let d = resolve_rate_spec(&RateConfigInput { env: Some(HashMap::new()), ..Default::default() });
        assert!(d.is_upstream_default);
        assert_eq!(d.spec, litellm_default_spec());
    }
}
