//! Period filtering, timestamp indexes and number formatting (port of util.ts).

use super::date::{js_date_parse, parse_since};
use super::js::{js_num_to_string, js_to_fixed, or_zero};
use crate::types::UsageEvent;

/// (since_ms, until_ms) bounds as the TS filters compute them.
pub fn period_bounds(since: Option<&str>, until: Option<&str>, time_zone: Option<&str>) -> (Option<f64>, Option<f64>) {
    let s = parse_since(since, time_zone);
    let u = until
        .filter(|u| !u.is_empty())
        .map(js_date_parse)
        .filter(|t| !t.is_nan());
    (s, u)
}

/// Filter events by [since, until] (inclusive), dropping unparsable timestamps
/// whenever a bound is active.
pub fn filter_by_period(
    events: &[UsageEvent],
    since: Option<&str>,
    until: Option<&str>,
    time_zone: Option<&str>,
) -> Vec<UsageEvent> {
    if events.is_empty() {
        return Vec::new();
    }
    let (s_ms, u_ms) = period_bounds(since, until, time_zone);
    if s_ms.is_none() && u_ms.is_none() {
        return events.to_vec();
    }
    events
        .iter()
        .filter(|e| {
            let t = js_date_parse(&e.timestamp);
            if t.is_nan() {
                return false;
            }
            if let Some(s) = s_ms {
                if t < s {
                    return false;
                }
            }
            if let Some(u) = u_ms {
                if t > u {
                    return false;
                }
            }
            true
        })
        .cloned()
        .collect()
}

/// Parallel timestamp index (ms) for events - NaN timestamps become 0.
pub fn build_timestamp_index(events: &[UsageEvent]) -> Vec<f64> {
    events
        .iter()
        .map(|e| {
            let t = js_date_parse(&e.timestamp);
            if t.is_nan() {
                0.0
            } else {
                t
            }
        })
        .collect()
}

/// Events sorted ascending by timestamp (stable), plus the parallel index.
pub fn sort_events_by_time(events: &[UsageEvent]) -> (Vec<UsageEvent>, Vec<f64>) {
    let n = events.len();
    if n == 0 {
        return (Vec::new(), Vec::new());
    }
    let ts = build_timestamp_index(events);
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| {
        ts[a]
            .partial_cmp(&ts[b])
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.cmp(&b))
    });
    let out_events = order.iter().map(|&i| events[i].clone()).collect();
    let out_ts = order.iter().map(|&i| ts[i]).collect();
    (out_events, out_ts)
}

/// First index with ts >= target.
pub fn bisect_left_ts(ts: &[f64], target: f64) -> usize {
    ts.partition_point(|&t| t < target)
}

/// First index with ts > target.
pub fn bisect_right_ts(ts: &[f64], target: f64) -> usize {
    ts.partition_point(|&t| t <= target)
}

/// `[lo, hi)` index range of a sorted timestamp index inside the period, or
/// None when no bound is active (everything matches).
pub fn sorted_period_range(
    timestamps_ms: &[f64],
    since: Option<&str>,
    until: Option<&str>,
    time_zone: Option<&str>,
) -> Option<(usize, usize)> {
    let (s_ms, u_ms) = period_bounds(since, until, time_zone);
    if s_ms.is_none() && u_ms.is_none() {
        return None;
    }
    let lo = s_ms.map_or(0, |s| bisect_left_ts(timestamps_ms, s));
    let hi = u_ms.map_or(timestamps_ms.len(), |u| bisect_right_ts(timestamps_ms, u));
    Some((lo, hi.max(lo)))
}

/// O(log n + k) period filter over events sorted ascending by timestamp.
pub fn filter_by_period_sorted(
    events: &[UsageEvent],
    timestamps_ms: &[f64],
    since: Option<&str>,
    until: Option<&str>,
    time_zone: Option<&str>,
) -> Vec<UsageEvent> {
    filter_by_period_sorted_detailed(events, timestamps_ms, since, until, time_zone).0
}

/// Like [`filter_by_period_sorted`] but also returns the sliced timestamp index.
pub fn filter_by_period_sorted_detailed(
    events: &[UsageEvent],
    timestamps_ms: &[f64],
    since: Option<&str>,
    until: Option<&str>,
    time_zone: Option<&str>,
) -> (Vec<UsageEvent>, Vec<f64>) {
    if events.is_empty() {
        return (Vec::new(), Vec::new());
    }
    if timestamps_ms.len() != events.len() {
        let filtered = filter_by_period(events, since, until, time_zone);
        let idx = build_timestamp_index(&filtered);
        return (filtered, idx);
    }
    match sorted_period_range(timestamps_ms, since, until, time_zone) {
        None => (events.to_vec(), timestamps_ms.to_vec()),
        Some((lo, hi)) => {
            if lo >= hi {
                (Vec::new(), Vec::new())
            } else {
                (events[lo..hi].to_vec(), timestamps_ms[lo..hi].to_vec())
            }
        }
    }
}

/// Format USD with thousand dots and decimal comma: `$197.527,96`.
pub fn format_usd(n: f64, digits: usize) -> String {
    let v = or_zero(n);
    let neg = v < 0.0;
    let fixed = js_to_fixed(v.abs(), digits);
    let (int_part, dec_part) = match fixed.split_once('.') {
        Some((i, d)) => (i.to_string(), Some(d.to_string())),
        None => (fixed.clone(), None),
    };
    let grouped = if int_part.bytes().all(|b| b.is_ascii_digit()) {
        let len = int_part.len();
        let mut out = String::with_capacity(len + len / 3);
        for (i, c) in int_part.chars().enumerate() {
            if i > 0 && (len - i) % 3 == 0 {
                out.push('.');
            }
            out.push(c);
        }
        out
    } else {
        int_part
    };
    format!(
        "{}{}{}",
        if neg { "-$" } else { "$" },
        grouped,
        dec_part.map(|d| format!(",{}", d)).unwrap_or_default()
    )
}

pub fn format_tokens(n: f64) -> String {
    if n >= 1_000_000_000.0 {
        format!("{}B", js_to_fixed(n / 1_000_000_000.0, 2))
    } else if n >= 1_000_000.0 {
        format!("{}M", js_to_fixed(n / 1_000_000.0, 2))
    } else if n >= 1_000.0 {
        format!("{}K", js_to_fixed(n / 1_000.0, 1))
    } else {
        js_num_to_string(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(ts: &str) -> UsageEvent {
        UsageEvent { timestamp: ts.to_string(), ..Default::default() }
    }

    #[test]
    fn usd_formatting() {
        assert_eq!(format_usd(197527.96, 2), "$197.527,96");
        assert_eq!(format_usd(-1234.5, 2), "-$1.234,50");
        assert_eq!(format_usd(0.0, 2), "$0,00");
        assert_eq!(format_usd(999.0, 0), "$999");
        assert_eq!(format_usd(1000.0, 0), "$1.000");
        assert_eq!(format_usd(f64::NAN, 2), "$0,00");
        assert_eq!(format_usd(1234567.891, 3), "$1.234.567,891");
    }

    #[test]
    fn token_formatting() {
        assert_eq!(format_tokens(999.0), "999");
        assert_eq!(format_tokens(1500.0), "1.5K");
        assert_eq!(format_tokens(2_500_000.0), "2.50M");
        assert_eq!(format_tokens(3_000_000_000.0), "3.00B");
        assert_eq!(format_tokens(0.5), "0.5");
    }

    #[test]
    fn period_filter_inclusive_and_drops_bad() {
        let events = vec![
            ev("2026-01-01T00:00:00Z"),
            ev("2026-01-02T00:00:00Z"),
            ev("bad"),
            ev("2026-01-03T00:00:00Z"),
        ];
        let f = filter_by_period(&events, Some("2026-01-02T00:00:00Z"), Some("2026-01-03T00:00:00Z"), None);
        assert_eq!(f.len(), 2);
        let all = filter_by_period(&events, None, None, None);
        assert_eq!(all.len(), 4);
    }

    #[test]
    fn sorted_filter_matches_linear() {
        let events = vec![
            ev("2026-01-03T00:00:00Z"),
            ev("2026-01-01T00:00:00Z"),
            ev("2026-01-02T00:00:00Z"),
        ];
        let (sorted, ts) = sort_events_by_time(&events);
        assert_eq!(sorted[0].timestamp, "2026-01-01T00:00:00Z");
        let a = filter_by_period_sorted(&sorted, &ts, Some("2026-01-02T00:00:00Z"), None, None);
        assert_eq!(a.len(), 2);
        let b = filter_by_period(&sorted, Some("2026-01-02T00:00:00Z"), None, None);
        assert_eq!(a.len(), b.len());
        let none = filter_by_period_sorted(&sorted, &ts, Some("2027-01-01T00:00:00Z"), None, None);
        assert!(none.is_empty());
    }
}
