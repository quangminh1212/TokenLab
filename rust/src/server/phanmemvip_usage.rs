//! Port of `src/server/phanmemvip-usage.ts`.
//!
//! Merges the PhanmemVIP minute-guard mirror with LiteLLM's request history to
//! report how many of the day's 17h50m minute budget have been used.

use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::HashSet;

use crate::types::{jsnum, AgentId, UsageEvent};
use crate::util::{js_date_parse, js_number_from_str, js_round, js_trim, to_iso_string};

pub const PHANMEMVIP_DAILY_LIMIT_MINUTES: f64 = (17 * 60 + 50) as f64;

const MINUTE_MS: f64 = 60_000.0;
const DAY_MS: f64 = 24.0 * 60.0 * MINUTE_MS;
const VIETNAM_OFFSET: &str = "+07:00";

/// `PhanmemvipUsage` (JSON field order: date, usedMinutes, limitMinutes,
/// updatedAt).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhanmemvipUsage {
    pub date: String,
    #[serde(serialize_with = "jsnum::ser_opt")]
    pub used_minutes: Option<f64>,
    #[serde(with = "jsnum")]
    pub limit_minutes: f64,
    pub updated_at: Option<String>,
}

static RE_PREFIX_ALIAS: Lazy<Regex> = Lazy::new(|| Regex::new(r"^(?:pmv|vip|phanmemvip)[-_]").unwrap());
static RE_CLAUDE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^claude-(?:fable|sonnet|opus)(?:[-_./]|$)").unwrap());
static RE_KIMI: Lazy<Regex> = Lazy::new(|| Regex::new(r"^kimi-k3(?:[-_./]|$)").unwrap());

/// `.replace(/^[a-z0-9_-]+\//, "")`
fn strip_provider_prefix(name: &str) -> &str {
    if let Some(i) = name.find('/') {
        let head = &name[..i];
        if !head.is_empty()
            && head
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
        {
            return &name[i + 1..];
        }
    }
    name
}

fn phanmemvip_model(model: Option<&str>) -> bool {
    let model = match model {
        Some(m) if !m.is_empty() => m,
        _ => return false,
    };
    let lower = js_trim(model).to_lowercase();
    let name = strip_provider_prefix(&lower);
    name == "xlab" || RE_PREFIX_ALIAS.is_match(name) || RE_CLAUDE.is_match(name) || RE_KIMI.is_match(name)
}

fn day_start_ms(date: &str) -> f64 {
    js_date_parse(&format!("{date}T00:00:00{VIETNAM_OFFSET}"))
}

struct EventUsage {
    used_minutes: f64,
    updated_at: Option<String>,
}

fn summarize_event_usage(events: &[UsageEvent], date: &str) -> EventUsage {
    let day_start = day_start_ms(date);
    if !day_start.is_finite() {
        return EventUsage {
            used_minutes: 0.0,
            updated_at: None,
        };
    }
    let day_end = day_start + DAY_MS;
    let mut active_minutes: HashSet<i64> = HashSet::new();
    let mut latest = f64::NEG_INFINITY;

    for event in events {
        if event.agent != AgentId::Litellm || !phanmemvip_model(event.model.as_deref()) {
            continue;
        }
        // Daily rollups carry many requests but do not preserve which minutes were active.
        if event.estimated == Some(true) || event.request_count.map_or(false, |c| c > 1.0) {
            continue;
        }
        let timestamp = event.timestamp.js_ms();
        if !timestamp.is_finite() || timestamp < day_start || timestamp >= day_end {
            continue;
        }
        active_minutes.insert((timestamp / MINUTE_MS).floor() as i64);
        if timestamp > latest {
            latest = timestamp;
        }
    }

    EventUsage {
        used_minutes: PHANMEMVIP_DAILY_LIMIT_MINUTES.min(active_minutes.len() as f64),
        updated_at: if latest.is_finite() { to_iso_string(latest) } else { None },
    }
}

/// JS `Number(value)` for the JSON shapes a mirror file can contain.
pub(crate) fn js_number_of_value(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => js_number_from_str(s),
        Value::Bool(b) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Value::Null => 0.0,
        Value::Array(a) => match a.len() {
            0 => 0.0,
            1 => js_number_of_value(&a[0]),
            _ => f64::NAN,
        },
        Value::Object(_) => f64::NAN,
    }
}

fn read_mirror_minutes(mirror: Option<&Map<String, Value>>) -> Option<f64> {
    let mirror = mirror?;
    if let Some(Value::Array(minutes)) = mirror.get("minutes") {
        let set: HashSet<&str> = minutes.iter().filter_map(|m| m.as_str()).collect();
        return Some(set.len() as f64);
    }
    match mirror.get("usedMinutes") {
        None | Some(Value::Null) => return None,
        Some(Value::String(s)) if s.is_empty() => return None,
        _ => {}
    }
    let value = js_number_of_value(mirror.get("usedMinutes").unwrap());
    if value.is_finite() && value >= 0.0 {
        Some(js_round(value))
    } else {
        None
    }
}

fn later_timestamp(values: &[Option<&str>]) -> Option<String> {
    let mut latest: Option<String> = None;
    let mut latest_ms = f64::NEG_INFINITY;
    for value in values {
        let value = match value {
            Some(v) if !v.is_empty() => *v,
            _ => continue,
        };
        let timestamp = js_date_parse(value);
        if timestamp.is_finite() && timestamp > latest_ms {
            latest = Some(value.to_string());
            latest_ms = timestamp;
        }
    }
    latest
}

/// Merge the minute guard mirror with LiteLLM's request history. The guard
/// mirror is authoritative when it contains a current-day timestamp or minute
/// list; otherwise request history fills the gap instead of turning a stale
/// mirror into a fresh-looking zero.
pub fn resolve_phanmemvip_usage(
    mirror: Option<&Map<String, Value>>,
    events: &[UsageEvent],
    date: &str,
) -> PhanmemvipUsage {
    let event_usage = summarize_event_usage(events, date);
    let day_start = day_start_ms(date);
    let day_end = day_start + DAY_MS;

    let mirror_is_today = mirror
        .and_then(|m| m.get("date"))
        .and_then(|d| d.as_str())
        .map_or(false, |d| d == date);
    let mirror_minutes = if mirror_is_today { read_mirror_minutes(mirror) } else { None };
    let mirror_updated_at: Option<&str> = mirror.and_then(|m| m.get("updatedAt")).and_then(|v| v.as_str());
    let mirror_updated_ms = match mirror_updated_at {
        Some(s) if !s.is_empty() => js_date_parse(s),
        _ => f64::NAN,
    };
    let mirror_timestamp_is_today =
        mirror_updated_ms.is_finite() && mirror_updated_ms >= day_start && mirror_updated_ms < day_end;
    let minutes_is_array = matches!(mirror.and_then(|m| m.get("minutes")), Some(Value::Array(_)));
    let has_current_mirror_evidence = mirror_minutes.is_some() && (mirror_timestamp_is_today || minutes_is_array);
    let valid_mirror_minutes = if has_current_mirror_evidence { mirror_minutes } else { None };

    if valid_mirror_minutes.is_none() && event_usage.used_minutes == 0.0 {
        return PhanmemvipUsage {
            date: date.to_string(),
            used_minutes: None,
            limit_minutes: PHANMEMVIP_DAILY_LIMIT_MINUTES,
            updated_at: None,
        };
    }

    PhanmemvipUsage {
        date: date.to_string(),
        used_minutes: Some(PHANMEMVIP_DAILY_LIMIT_MINUTES.min(valid_mirror_minutes.unwrap_or(0.0).max(event_usage.used_minutes))),
        limit_minutes: PHANMEMVIP_DAILY_LIMIT_MINUTES,
        updated_at: later_timestamp(&[
            if mirror_timestamp_is_today { mirror_updated_at } else { None },
            event_usage.updated_at.as_deref(),
        ]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn litellm_event(model: &str, ts: &str) -> UsageEvent {
        UsageEvent {
            agent: AgentId::Litellm,
            model: Some(model.to_string().into()),
            timestamp: ts.to_string().into(),
            ..Default::default()
        }
    }

    #[test]
    fn model_matching() {
        assert!(phanmemvip_model(Some("xlab")));
        assert!(phanmemvip_model(Some("openai/xlab")));
        assert!(phanmemvip_model(Some("PMV-fast")));
        assert!(phanmemvip_model(Some("claude-sonnet-4")));
        assert!(phanmemvip_model(Some("claude-opus")));
        assert!(phanmemvip_model(Some("kimi-k3.1")));
        assert!(!phanmemvip_model(Some("claude-haiku-4")));
        assert!(!phanmemvip_model(Some("gpt-5")));
        assert!(!phanmemvip_model(None));
    }

    #[test]
    fn empty_everything_is_null() {
        let r = resolve_phanmemvip_usage(None, &[], "2026-01-02");
        assert_eq!(r.used_minutes, None);
        assert_eq!(r.updated_at, None);
        assert_eq!(r.limit_minutes, 1070.0);
    }

    #[test]
    fn events_fill_minutes() {
        let evs = vec![
            litellm_event("xlab", "2026-01-02T01:00:10+07:00"),
            litellm_event("xlab", "2026-01-02T01:00:50+07:00"),
            litellm_event("xlab", "2026-01-02T01:02:00+07:00"),
            litellm_event("gpt-5", "2026-01-02T01:03:00+07:00"),
        ];
        let r = resolve_phanmemvip_usage(None, &evs, "2026-01-02");
        assert_eq!(r.used_minutes, Some(2.0));
        assert_eq!(r.updated_at.as_deref(), Some("2026-01-01T18:02:00.000Z"));
    }

    #[test]
    fn mirror_minutes_list_is_authoritative() {
        let mirror = json!({"date": "2026-01-02", "minutes": ["a", "b", "a", 5], "updatedAt": "2026-01-02T02:00:00+07:00"});
        let r = resolve_phanmemvip_usage(mirror.as_object(), &[], "2026-01-02");
        assert_eq!(r.used_minutes, Some(2.0));
        assert_eq!(r.updated_at.as_deref(), Some("2026-01-02T02:00:00+07:00"));
    }

    #[test]
    fn stale_mirror_without_evidence_is_ignored() {
        let mirror = json!({"date": "2026-01-02", "usedMinutes": 40, "updatedAt": "2026-01-01T02:00:00+07:00"});
        let r = resolve_phanmemvip_usage(mirror.as_object(), &[], "2026-01-02");
        assert_eq!(r.used_minutes, None);
    }

    #[test]
    fn used_minutes_rounds_and_caps() {
        let mirror = json!({"date": "2026-01-02", "usedMinutes": "2000.4", "updatedAt": "2026-01-02T02:00:00+07:00"});
        let r = resolve_phanmemvip_usage(mirror.as_object(), &[], "2026-01-02");
        assert_eq!(r.used_minutes, Some(1070.0));
    }
}
