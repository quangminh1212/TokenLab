//! Port of `src/flag-report.ts`.
//!
//! "Why was this key flagged as a tool/bot?" diagnostics. Every defensible
//! reading of "hours active" is reported side by side; none is collapsed into a
//! single number. Days are UTC calendar days.

use crate::types::{jsnum, UsageEvent};
use crate::util::{js_date_parse, js_num_to_string, js_number_from_str, js_to_fixed, to_iso_string};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// A request with its resolved epoch-milliseconds timestamp.
#[derive(Clone, Copy)]
struct TimedPoint {
    at_ms: f64,
}

/// How much of a day the key was active, under each defensible definition.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DayActivity {
    /// Calendar day, `YYYY-MM-DD`, UTC.
    pub day: String,
    #[serde(with = "jsnum")]
    pub request_count: f64,
    #[serde(with = "jsnum")]
    pub span_hours: f64,
    #[serde(with = "jsnum")]
    pub active_minutes: f64,
    #[serde(with = "jsnum")]
    pub active_hours: f64,
    #[serde(with = "jsnum")]
    pub hours_with_traffic: f64,
    #[serde(with = "jsnum")]
    pub idle_hours_in_span: f64,
    pub idle_hours: Vec<u32>,
    #[serde(with = "jsnum")]
    pub longest_continuous_run_hours: f64,
    #[serde(default, serialize_with = "jsnum::ser_opt", deserialize_with = "jsnum::de_opt")]
    pub median_gap_seconds: Option<f64>,
    #[serde(with = "jsnum")]
    pub share_gaps_under60s: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlagThresholds {
    #[serde(with = "jsnum")]
    pub span_hours: f64,
    #[serde(with = "jsnum")]
    pub active_hours: f64,
    #[serde(with = "jsnum")]
    pub continuous_gap_seconds: f64,
    #[serde(with = "jsnum")]
    pub max_idle_hours: f64,
    #[serde(with = "jsnum")]
    pub automated_gap_share: f64,
}

impl Default for FlagThresholds {
    fn default() -> Self {
        default_flag_thresholds()
    }
}

pub fn default_flag_thresholds() -> FlagThresholds {
    FlagThresholds {
        span_hours: 18.0,
        active_hours: 12.0,
        continuous_gap_seconds: 300.0,
        max_idle_hours: 0.0,
        automated_gap_share: 0.9,
    }
}

/// JS `Number(v)` over a loosely-typed JSON value (`None` = `undefined`).
fn js_number_of(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => js_number_from_str(s),
        Some(Value::Array(a)) => {
            // Number([]) === 0, Number([x]) === Number(x), longer arrays NaN.
            match a.len() {
                0 => 0.0,
                1 => js_number_of(a.first()),
                _ => f64::NAN,
            }
        }
        Some(Value::Object(_)) => f64::NAN,
    }
}

/// Merge partial config over the defaults, rejecting values that would make the
/// report meaningless. A bad field falls back to its default.
pub fn resolve_flag_thresholds(partial: Option<&Value>) -> FlagThresholds {
    let base = default_flag_thresholds();
    let obj = match partial {
        Some(v @ Value::Object(_)) => v,
        _ => return base,
    };
    let get = |k: &str| obj.get(k);

    let hours = |v: Option<&Value>, fallback: f64| -> f64 {
        let n = js_number_of(v);
        if n.is_finite() && n >= 0.0 && n <= 24.0 * 31.0 {
            n
        } else {
            fallback
        }
    };
    let seconds = |v: Option<&Value>, fallback: f64| -> f64 {
        let n = js_number_of(v);
        if n.is_finite() && n > 0.0 {
            n
        } else {
            fallback
        }
    };
    let share = |v: Option<&Value>, fallback: f64| -> f64 {
        let n = js_number_of(v);
        if n.is_finite() && (0.0..=1.0).contains(&n) {
            n
        } else {
            fallback
        }
    };

    FlagThresholds {
        span_hours: hours(get("spanHours"), base.span_hours),
        active_hours: hours(get("activeHours"), base.active_hours),
        continuous_gap_seconds: seconds(get("continuousGapSeconds"), base.continuous_gap_seconds),
        // maxIdleHours is an upper bound that may legitimately be 0.
        max_idle_hours: hours(get("maxIdleHours"), base.max_idle_hours),
        automated_gap_share: share(get("automatedGapShare"), base.automated_gap_share),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DayVerdict {
    pub day: String,
    pub flagged: bool,
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlagReport {
    pub thresholds: FlagThresholds,
    pub days: Vec<DayActivity>,
    pub verdicts: Vec<DayVerdict>,
    pub days_over_span: Vec<String>,
    pub days_over_active: Vec<String>,
    pub days_round_the_clock: Vec<String>,
    pub days_automated_cadence: Vec<String>,
    #[serde(with = "jsnum")]
    pub longest_run_hours: f64,
    #[serde(default, serialize_with = "jsnum::ser_opt", deserialize_with = "jsnum::de_opt")]
    pub median_gap_seconds: Option<f64>,
    #[serde(with = "jsnum")]
    pub share_gaps_under60s: f64,
}

/// `new Date(ms).toISOString().slice(0, 10)`.
fn day_key_utc(ms: f64) -> String {
    to_iso_string(ms)
        .map(|s| s.chars().take(10).collect())
        .unwrap_or_default()
}

/// `new Date(ms).getUTCHours()`.
fn utc_hours(ms: f64) -> u32 {
    let day = 86_400_000.0;
    let rem = ms - (ms / day).floor() * day;
    (rem / 3_600_000.0).floor() as u32
}

fn median(sorted: &[f64]) -> Option<f64> {
    if sorted.is_empty() {
        return None;
    }
    let mid = sorted.len() >> 1;
    if sorted.len() % 2 == 1 {
        return Some(sorted[mid]);
    }
    Some((sorted[mid - 1] + sorted[mid]) / 2.0)
}

fn sort_f64(v: &mut [f64]) {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
}

/// Longest continuous run: continues while each consecutive gap is
/// `<= max_gap_seconds`.
fn longest_continuous_run_seconds(points: &[TimedPoint], max_gap_seconds: f64) -> f64 {
    if points.len() < 2 {
        return 0.0;
    }
    let mut best = 0.0;
    let mut current = 0.0;
    for i in 1..points.len() {
        let gap = (points[i].at_ms - points[i - 1].at_ms) / 1000.0;
        if gap <= max_gap_seconds {
            current += gap;
        } else {
            current = 0.0;
        }
        if current > best {
            best = current;
        }
    }
    best
}

/// Resolve events to ascending timed points. Estimated daily rollups are
/// dropped (a whole day's count under one timestamp would fake a long run).
fn to_timed_points(events: &[UsageEvent]) -> Vec<TimedPoint> {
    let mut out: Vec<TimedPoint> = Vec::new();
    for e in events {
        if e.estimated == Some(true) {
            continue;
        }
        let at_ms = js_date_parse(&e.timestamp);
        if !at_ms.is_finite() {
            continue;
        }
        out.push(TimedPoint { at_ms });
    }
    out.sort_by(|a, b| {
        a.at_ms
            .partial_cmp(&b.at_ms)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    out
}

/// Per-day activity under every defensible definition.
pub fn compute_day_activity(events: &[UsageEvent], thresholds: &FlagThresholds) -> Vec<DayActivity> {
    let points = to_timed_points(events);
    let mut by_day: BTreeMap<String, Vec<TimedPoint>> = BTreeMap::new();
    for p in &points {
        by_day.entry(day_key_utc(p.at_ms)).or_default().push(*p);
    }

    let mut out: Vec<DayActivity> = Vec::new();
    for (day, items) in by_day {
        let first = items[0].at_ms;
        let last = items[items.len() - 1].at_ms;
        let span_hours = (last - first) / 3_600_000.0;

        let mut minute_buckets: std::collections::HashSet<i64> = std::collections::HashSet::new();
        let mut hour_buckets: std::collections::HashSet<u32> = std::collections::HashSet::new();
        for p in &items {
            minute_buckets.insert((p.at_ms / 60_000.0).floor() as i64);
            hour_buckets.insert(utc_hours(p.at_ms));
        }
        let active_minutes = minute_buckets.len() as f64;
        let active_hours = active_minutes / 60.0;

        let first_hour = utc_hours(first);
        let last_hour = utc_hours(last);
        let mut idle_hours: Vec<u32> = Vec::new();
        let mut h = first_hour;
        while h <= last_hour {
            if !hour_buckets.contains(&h) {
                idle_hours.push(h);
            }
            h += 1;
        }

        let mut gaps: Vec<f64> = Vec::new();
        for i in 1..items.len() {
            gaps.push((items[i].at_ms - items[i - 1].at_ms) / 1000.0);
        }
        let mut sorted_gaps = gaps.clone();
        sort_f64(&mut sorted_gaps);
        let under60 = gaps.iter().filter(|g| **g <= 60.0).count();

        out.push(DayActivity {
            day,
            request_count: items.len() as f64,
            span_hours,
            active_minutes,
            active_hours,
            hours_with_traffic: hour_buckets.len() as f64,
            idle_hours_in_span: idle_hours.len() as f64,
            idle_hours,
            longest_continuous_run_hours: longest_continuous_run_seconds(
                &items,
                thresholds.continuous_gap_seconds,
            ) / 3600.0,
            median_gap_seconds: median(&sorted_gaps),
            share_gaps_under60s: if !gaps.is_empty() {
                under60 as f64 / gaps.len() as f64
            } else {
                0.0
            },
        });
    }
    out
}

/// Full flag report: per-day numbers plus each metric's day list.
/// Minimum distinct active hours before a day can count as "round the clock"
/// (a brief burst inside one hour trivially has zero idle hours).
const MIN_ROUND_THE_CLOCK_HOURS: f64 = 6.0;

fn is_round_the_clock(d: &DayActivity, thresholds: &FlagThresholds) -> bool {
    d.idle_hours_in_span <= thresholds.max_idle_hours && d.hours_with_traffic >= MIN_ROUND_THE_CLOCK_HOURS
}

pub fn compute_flag_report(events: &[UsageEvent], thresholds: &FlagThresholds) -> FlagReport {
    let days = compute_day_activity(events, thresholds);

    let days_over_span: Vec<String> = days
        .iter()
        .filter(|d| d.span_hours >= thresholds.span_hours)
        .map(|d| d.day.clone())
        .collect();
    let days_over_active: Vec<String> = days
        .iter()
        .filter(|d| d.active_hours >= thresholds.active_hours)
        .map(|d| d.day.clone())
        .collect();
    let days_round_the_clock: Vec<String> = days
        .iter()
        .filter(|d| is_round_the_clock(d, thresholds))
        .map(|d| d.day.clone())
        .collect();
    let days_automated_cadence: Vec<String> = days
        .iter()
        .filter(|d| d.share_gaps_under60s >= thresholds.automated_gap_share)
        .map(|d| d.day.clone())
        .collect();

    let verdicts: Vec<DayVerdict> = days
        .iter()
        .map(|d| {
            let mut reasons: Vec<String> = Vec::new();
            if d.span_hours >= thresholds.span_hours {
                reasons.push(format!(
                    "span {}h >= {}h (first\u{2192}last request, includes idle gaps)",
                    js_to_fixed(d.span_hours, 2),
                    js_num_to_string(thresholds.span_hours)
                ));
            }
            if d.active_hours >= thresholds.active_hours {
                reasons.push(format!(
                    "active {}h >= {}h (minutes containing a request)",
                    js_to_fixed(d.active_hours, 2),
                    js_num_to_string(thresholds.active_hours)
                ));
            }
            if is_round_the_clock(d, thresholds) {
                reasons.push(format!(
                    "traffic in every hour across the span ({} idle hour(s) <= {})",
                    js_num_to_string(d.idle_hours_in_span),
                    js_num_to_string(thresholds.max_idle_hours)
                ));
            }
            if d.share_gaps_under60s >= thresholds.automated_gap_share {
                reasons.push(format!(
                    "{}% of gaps <= 60s >= {}% (automated cadence)",
                    js_to_fixed(d.share_gaps_under60s * 100.0, 1),
                    js_to_fixed(thresholds.automated_gap_share * 100.0, 0)
                ));
            }
            DayVerdict {
                day: d.day.clone(),
                flagged: !reasons.is_empty(),
                reasons,
            }
        })
        .collect();

    // Period-wide cadence, computed the same way as the per-day figures.
    let points = to_timed_points(events);
    let mut all_gaps: Vec<f64> = Vec::new();
    for i in 1..points.len() {
        all_gaps.push((points[i].at_ms - points[i - 1].at_ms) / 1000.0);
    }
    let mut sorted_all = all_gaps.clone();
    sort_f64(&mut sorted_all);

    FlagReport {
        thresholds: *thresholds,
        days,
        verdicts,
        days_over_span,
        days_over_active,
        days_round_the_clock,
        days_automated_cadence,
        longest_run_hours: longest_continuous_run_seconds(&points, thresholds.continuous_gap_seconds)
            / 3600.0,
        median_gap_seconds: median(&sorted_all),
        share_gaps_under60s: if !all_gaps.is_empty() {
            all_gaps.iter().filter(|g| **g <= 60.0).count() as f64 / all_gaps.len() as f64
        } else {
            0.0
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(ts: &str) -> UsageEvent {
        UsageEvent {
            id: ts.to_string(),
            timestamp: ts.to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn thresholds_fallback() {
        let v: Value = serde_json::json!({"spanHours": -1, "activeHours": 5, "automatedGapShare": 2});
        let t = resolve_flag_thresholds(Some(&v));
        assert_eq!(t.span_hours, 18.0);
        assert_eq!(t.active_hours, 5.0);
        assert_eq!(t.automated_gap_share, 0.9);
        assert_eq!(resolve_flag_thresholds(None), default_flag_thresholds());
    }

    #[test]
    fn report_basic() {
        let events = vec![
            ev("2026-10-07T00:00:00.000Z"),
            ev("2026-10-07T00:00:10.000Z"),
            ev("2026-10-07T02:00:00.000Z"),
        ];
        let r = compute_flag_report(&events, &default_flag_thresholds());
        assert_eq!(r.days.len(), 1);
        assert_eq!(r.days[0].request_count, 3.0);
        assert_eq!(r.days[0].idle_hours, vec![1]);
        assert_eq!(r.days[0].median_gap_seconds, Some(3600.0));
        assert!((r.days[0].span_hours - 2.0).abs() < 1e-9);
    }
}
