//! Port of `src/aggregate.ts`.
//!
//! Periods, byModel/byAgent rollups, cache accounting, totals and RPM helpers.
//! Numbers are `f64` (JS `number`) and iteration/sort order mirrors the JS
//! `Map` + stable `Array.prototype.sort` semantics (insertion-ordered maps,
//! stable sorts) so output is numerically and positionally identical.

use crate::pricing::{get_rate_for_model, price_cost_parts, CostParts};
use crate::types::{jsnum, AgentId, GroupBy, GroupRow, Period, StatsResult, TokenTotals, UsageEvent};
use crate::util::{
    normalize_agent_id, normalize_model_for_agent, now_ms, or_zero, to_iso_string,
};
use indexmap::IndexMap;
use serde::Serialize;
use std::cmp::Ordering;
use std::collections::HashMap;

/// `sort: "tokens" | "cost"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SortBy {
    Tokens,
    Cost,
}

impl Default for SortBy {
    fn default() -> Self {
        SortBy::Cost
    }
}

impl From<&str> for SortBy {
    /// `sort === "cost" ? cost : tokens`.
    fn from(s: &str) -> Self {
        if s == "cost" {
            SortBy::Cost
        } else {
            SortBy::Tokens
        }
    }
}

impl SortBy {
    pub fn parse(s: &str) -> Option<SortBy> {
        match s {
            "tokens" => Some(SortBy::Tokens),
            "cost" => Some(SortBy::Cost),
            _ => None,
        }
    }
}

/// Fresh totals bucket (`emptyTotals`). Optional cost/cache counters start at
/// zero (present), `cacheReportedEvents` stays unset until a row reports.
fn empty_totals() -> TokenTotals {
    TokenTotals {
        input_tokens: 0.0,
        output_tokens: 0.0,
        cache_read_tokens: 0.0,
        cache_write_tokens: 0.0,
        total_tokens: 0.0,
        estimated_cost: 0.0,
        estimated_pricing: Some(false),
        input_cost: Some(0.0),
        cache_cost: Some(0.0),
        output_cost: Some(0.0),
        currency: "USD".to_string(),
        event_count: 0.0,
        cache_reported_events: None,
        cache_billed_tokens: Some(0.0),
        cache_free_tokens: Some(0.0),
    }
}

fn new_row(key: &str) -> GroupRow {
    GroupRow {
        key: key.to_string(),
        totals: empty_totals(),
        rpm: None,
    }
}

/// Per-event facts derived once (rate lookup) and reused for every bucket the
/// event lands in.
struct EventInfo {
    estimated_rate: bool,
    discounts_cache: bool,
}

fn event_info(e: &UsageEvent) -> EventInfo {
    let model = normalize_model_for_agent(e.model.as_deref(), Some(e.agent.as_str()));
    let rate = get_rate_for_model(model.as_deref()).rate;
    // A bucket can carry billions of cache-hit tokens and still bill $0.00 for
    // them (LiteLLM mirrors Claude traffic at cacheReadPer1M === inputPer1M).
    let discounts_cache = matches!(rate.cache_read_per_1m, Some(c) if c < rate.input_per_1m);
    EventInfo {
        estimated_rate: rate.estimated == Some(true),
        discounts_cache,
    }
}

/// `typeof reqs === "number" && isFinite && > 0 ? Math.floor(reqs) : 1`.
fn event_request_count(e: &UsageEvent) -> f64 {
    match e.request_count {
        Some(rc) if rc.is_finite() && rc > 0.0 => rc.floor(),
        _ => 1.0,
    }
}

fn parts_for(e: &UsageEvent) -> CostParts {
    let model = normalize_model_for_agent(e.model.as_deref(), Some(e.agent.as_str()));
    price_cost_parts(
        model.as_deref(),
        or_zero(e.input_tokens),
        or_zero(e.output_tokens),
        or_zero(e.cache_read_tokens),
        or_zero(e.cache_write_tokens),
        e.estimated_cost,
    )
}

fn add_with_parts(t: &mut TokenTotals, e: &UsageEvent, parts: &CostParts, info: &EventInfo) {
    t.input_tokens += or_zero(e.input_tokens);
    t.output_tokens += or_zero(e.output_tokens);
    t.cache_read_tokens += or_zero(e.cache_read_tokens);
    t.cache_write_tokens += or_zero(e.cache_write_tokens);
    t.total_tokens += or_zero(e.total_tokens);
    t.estimated_cost += e.estimated_cost.unwrap_or(0.0);
    if info.estimated_rate {
        t.estimated_pricing = Some(true);
    }
    t.input_cost = Some(or_zero(t.input_cost.unwrap_or(0.0)) + parts.input_cost);
    t.cache_cost = Some(or_zero(t.cache_cost.unwrap_or(0.0)) + parts.cache_cost);
    t.output_cost = Some(or_zero(t.output_cost.unwrap_or(0.0)) + parts.output_cost);
    // Split the cache-read bucket by whether the rate table actually discounts it.
    let cache_read = or_zero(e.cache_read_tokens);
    if cache_read > 0.0 {
        if info.discounts_cache {
            t.cache_billed_tokens = Some(or_zero(t.cache_billed_tokens.unwrap_or(0.0)) + cache_read);
        } else {
            t.cache_free_tokens = Some(or_zero(t.cache_free_tokens.unwrap_or(0.0)) + cache_read);
        }
    }
    // A row with explicit zeroes still counts: "the provider said 0" is a
    // measurement, unlike silence.
    if e.cache_reported == Some(true) {
        t.cache_reported_events = Some(or_zero(t.cache_reported_events.unwrap_or(0.0)) + 1.0);
    }
    // Sum real API requests (daily rollups carry model.requests; per-call rows = 1)
    t.event_count += event_request_count(e);
}

// Keep these aliases aligned with MODEL_DISPLAY_ALIASES in dashboard.html.
// Group on the displayed model name so aliases share totals and peak RPM.
fn model_group_alias(key: &str) -> Option<&'static str> {
    Some(match key {
        "adaptive" => "big-pickle",
        "big pickle" => "big-pickle",
        "coding" => "claude-fable-5",
        "claude fable 5" => "claude-fable-5",
        "qwen3.8-27b" => "qwen3.8-max",
        "qwen3.8-max-preview" => "qwen3.8-max",
        "qwen3guard-gen-0.6b" => "qwen3.8-max",
        "qwen3guard-gen-8b" => "qwen3.8-max",
        "qwenheavy" => "qwen3.8-max",
        "qwen 3.8 max" => "qwen3.8-max",
        "qwencoder qwen3.8 max" => "qwen3.8-max",
        _ => return None,
    })
}

// These legacy 9r route labels represent GPT-5.5 in the All-time model view.
// Keep the aliasing display-only so the recorded event pricing is preserved.
fn is_all_time_gpt55_alias(model_alias: &str) -> bool {
    matches!(model_alias, "9r or openrouter" | "9r xlab")
}

/// Keep unresolved usage in account/provider totals without inventing a model.
fn has_unresolved_model(e: &UsageEvent, all_time_model_aliases: bool) -> bool {
    if normalize_model_for_agent(e.model.as_deref(), Some(e.agent.as_str())).is_some() {
        return false;
    }
    // The missing-model 9Router/RouterLab all-time rows are GPT-5.5. This
    // display-only alias does not apply to other periods.
    !(all_time_model_aliases && (e.agent == AgentId::Routerlab || e.agent == AgentId::NineRouter))
}

fn model_group_key(e: &UsageEvent, all_time_model_aliases: bool) -> String {
    let model = normalize_model_for_agent(e.model.as_deref(), Some(e.agent.as_str()));
    let agent = normalize_agent_id(Some(e.agent.as_str()));
    let model_alias = model.as_ref().map(|m| m.to_lowercase().replace('-', " "));
    if all_time_model_aliases
        && ((model.is_none() && (agent == AgentId::Routerlab || agent == AgentId::NineRouter))
            || matches!(&model_alias, Some(a) if is_all_time_gpt55_alias(a)))
    {
        return "gpt 5.5".to_string();
    }
    // A missing/synthetic source label has no single model to attribute it to.
    let key = match &model {
        Some(m) if !m.is_empty() => m.to_lowercase(),
        _ => format!("unattributed ({})", e.agent.as_str()).to_lowercase(),
    };
    let aliased = model_group_alias(&key).map(|s| s.to_string()).unwrap_or(key);
    aliased.replace('-', " ")
}

/// First `n` UTF-16-ish characters of an ISO string (`slice(0, n)`); ISO output
/// is ASCII so char slicing is exact.
fn iso_prefix(ms: f64, n: usize) -> Option<String> {
    to_iso_string(ms).map(|s| s.chars().take(n).collect())
}

fn group_key(e: &UsageEvent, by: GroupBy, ts_ms: Option<f64>, all_time_model_aliases: bool) -> String {
    match by {
        GroupBy::Agent => return e.agent.as_str().to_string(),
        GroupBy::Model => return model_group_key(e, all_time_model_aliases),
        _ => {}
    }
    let t = match ts_ms {
        Some(t) if t.is_finite() => t,
        _ => e.timestamp.js_ms(),
    };
    if !t.is_finite() {
        return "unknown".to_string();
    }
    match by {
        GroupBy::Day => match iso_prefix(t, 10) {
            Some(s) => s,
            None => "unknown".to_string(),
        },
        _ => match iso_prefix(t, 13) {
            Some(s) => format!("{}:00", s),
            None => "unknown".to_string(),
        },
    }
}

fn sort_groups(groups: &mut [GroupRow], sort: SortBy) {
    // Stable sort, like `Array.prototype.sort`; NaN comparisons count as equal.
    groups.sort_by(|a, b| match sort {
        SortBy::Cost => b
            .totals
            .estimated_cost
            .partial_cmp(&a.totals.estimated_cost)
            .unwrap_or(Ordering::Equal),
        SortBy::Tokens => b
            .totals
            .total_tokens
            .partial_cmp(&a.totals.total_tokens)
            .unwrap_or(Ordering::Equal),
    });
}

#[allow(clippy::too_many_arguments)]
pub fn aggregate(
    events: &[UsageEvent],
    group_by: GroupBy,
    sort: impl Into<SortBy>,
    since: Option<&str>,
    until: Option<&str>,
    // Optional parallel ms timestamps (same length) — avoids re-parse for day/hour keys
    timestamps_ms: Option<&[f64]>,
    all_time_model_aliases: bool,
) -> StatsResult {
    let sort: SortBy = sort.into();
    let mut totals = empty_totals();
    let mut map: IndexMap<String, GroupRow> = IndexMap::new();
    let n = events.len();
    let ts = timestamps_ms.filter(|t| t.len() == n);

    for (i, e) in events.iter().enumerate() {
        // priceCostParts once per event (totals + group row)
        let parts = parts_for(e);
        let info = event_info(e);
        add_with_parts(&mut totals, e, &parts, &info);
        if group_by == GroupBy::Model && has_unresolved_model(e, all_time_model_aliases) {
            continue;
        }
        let key = group_key(e, group_by, ts.map(|t| t[i]), all_time_model_aliases);
        let row = map.entry(key.clone()).or_insert_with(|| new_row(&key));
        add_with_parts(&mut row.totals, e, &parts, &info);
    }

    let mut groups: Vec<GroupRow> = map.into_values().collect();
    sort_groups(&mut groups, sort);

    // Every group row carries its own peak RPM. A group with no live rows keeps
    // `rpm` unset (rendered as "—") rather than 0.
    let rpm_map = rpm_by_group(events, group_by, timestamps_ms, RpmScope::Table, all_time_model_aliases);
    for g in groups.iter_mut() {
        if let Some(peak) = rpm_map.get(&g.key) {
            g.rpm = Some(*peak);
        }
    }

    StatsResult {
        totals,
        groups,
        group_by,
        period: Period {
            since: since.map(|s| s.to_string()),
            until: until.map(|s| s.to_string()),
        },
    }
}

/// `aggregate(events, groupBy, sort)` with every optional argument defaulted.
pub fn aggregate_simple(events: &[UsageEvent], group_by: GroupBy, sort: SortBy) -> StatsResult {
    aggregate(events, group_by, sort, None, None, None, false)
}

/// Dashboard period keys (match UI segment + since query).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum DashPeriodKey {
    Today,
    H24,
    D7,
    D30,
    All,
}

impl DashPeriodKey {
    pub const ALL: [DashPeriodKey; 5] = [
        DashPeriodKey::Today,
        DashPeriodKey::H24,
        DashPeriodKey::D7,
        DashPeriodKey::D30,
        DashPeriodKey::All,
    ];

    pub fn as_str(&self) -> &'static str {
        match self {
            DashPeriodKey::Today => "today",
            DashPeriodKey::H24 => "24h",
            DashPeriodKey::D7 => "7d",
            DashPeriodKey::D30 => "30d",
            DashPeriodKey::All => "all",
        }
    }

    pub fn parse(s: &str) -> Option<DashPeriodKey> {
        match s {
            "today" => Some(DashPeriodKey::Today),
            "24h" => Some(DashPeriodKey::H24),
            "7d" => Some(DashPeriodKey::D7),
            "30d" => Some(DashPeriodKey::D30),
            "all" => Some(DashPeriodKey::All),
            _ => None,
        }
    }
}

impl Serialize for DashPeriodKey {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

/// `Record<GroupBy, StatsResult>`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ByGroup {
    pub agent: StatsResult,
    pub model: StatsResult,
    pub day: StatsResult,
    pub hour: StatsResult,
}

impl ByGroup {
    pub fn get(&self, by: GroupBy) -> &StatsResult {
        match by {
            GroupBy::Agent => &self.agent,
            GroupBy::Model => &self.model,
            GroupBy::Day => &self.day,
            GroupBy::Hour => &self.hour,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrecomputedPeriodStats {
    #[serde(with = "jsnum")]
    pub built_at: f64,
    /// groupBy -> StatsResult (sort=cost for agent/model, tokens for day/hour)
    pub by_group: ByGroup,
    pub usage_rpm: ActiveUsageRpm,
}

struct Acc {
    totals: TokenTotals,
    agent: IndexMap<String, GroupRow>,
    model: IndexMap<String, GroupRow>,
    day: IndexMap<String, GroupRow>,
    hour: IndexMap<String, GroupRow>,
    rpm_events: Vec<usize>,
}

fn bump(map: &mut IndexMap<String, GroupRow>, key: &str, e: &UsageEvent, parts: &CostParts, info: &EventInfo) {
    if let Some(row) = map.get_mut(key) {
        add_with_parts(&mut row.totals, e, parts, info);
        return;
    }
    let row = map.entry(key.to_string()).or_insert_with(|| new_row(key));
    add_with_parts(&mut row.totals, e, parts, info);
}

/// Single-pass precompute for dashboard period tabs.
/// One priceCostParts per event total (not 2x per groupBy x period) so Today<->30D
/// switches are Map lookups instead of multi-second full rescans.
///
/// `bounds` maps each period to its inclusive start (ms); a missing/`None`
/// entry means unbounded.
pub fn precompute_dashboard_periods(
    events: &[UsageEvent],
    timestamps_ms: &[f64],
    bounds: &HashMap<DashPeriodKey, Option<f64>>,
    now: f64,
) -> IndexMap<DashPeriodKey, PrecomputedPeriodStats> {
    let keys = DashPeriodKey::ALL;
    let mut acc: IndexMap<DashPeriodKey, Acc> = IndexMap::new();
    for k in keys {
        acc.insert(
            k,
            Acc {
                totals: empty_totals(),
                agent: IndexMap::new(),
                model: IndexMap::new(),
                day: IndexMap::new(),
                hour: IndexMap::new(),
                rpm_events: Vec::new(),
            },
        );
    }

    let n = events.len();
    let use_ts = timestamps_ms.len() == n;
    // day/hour keys are identical for every event inside the same UTC hour.
    let mut hour_cache: (i64, String, String) = (i64::MIN, String::new(), String::new());

    for (i, e) in events.iter().enumerate() {
        let t = if use_ts { timestamps_ms[i] } else { e.timestamp.js_ms() };
        if !t.is_finite() {
            continue;
        }
        let parts = parts_for(e);
        let info = event_info(e);
        let agent_key = e.agent.as_str();
        let model_key = model_group_key(e, false);
        let all_time_model_key = model_group_key(e, true);
        let hb = (t / 3_600_000.0).floor() as i64;
        if hour_cache.0 != hb {
            hour_cache = (
                hb,
                iso_prefix(t, 10).unwrap_or_default(),
                format!("{}:00", iso_prefix(t, 13).unwrap_or_default()),
            );
        }
        let day_key = hour_cache.1.as_str();
        let hour_key = hour_cache.2.as_str();
        let unresolved = has_unresolved_model(e, false);
        let unresolved_all = has_unresolved_model(e, true);

        for pk in keys {
            let start = bounds.get(&pk).copied().flatten();
            if let Some(s) = start {
                if t < s {
                    continue;
                }
            }
            if t > now + 5_000.0 {
                continue;
            }
            let a = acc.get_mut(&pk).unwrap();
            add_with_parts(&mut a.totals, e, &parts, &info);
            bump(&mut a.agent, agent_key, e, &parts, &info);
            let is_all = pk == DashPeriodKey::All;
            if !(if is_all { unresolved_all } else { unresolved }) {
                bump(
                    &mut a.model,
                    if is_all { &all_time_model_key } else { &model_key },
                    e,
                    &parts,
                    &info,
                );
            }
            bump(&mut a.day, day_key, e, &parts, &info);
            // Hour series only needed for today/24h charts
            if pk == DashPeriodKey::Today || pk == DashPeriodKey::H24 {
                bump(&mut a.hour, hour_key, e, &parts, &info);
            }
            a.rpm_events.push(i);
        }
    }

    let finish = |map: IndexMap<String, GroupRow>, group_by: GroupBy, sort: SortBy, since: Option<&str>| {
        let mut groups: Vec<GroupRow> = map.into_values().collect();
        sort_groups(&mut groups, sort);
        StatsResult {
            totals: empty_totals(), // filled below
            groups,
            group_by,
            period: Period {
                since: since.map(|s| s.to_string()),
                until: None,
            },
        }
    };

    let mut out: IndexMap<DashPeriodKey, PrecomputedPeriodStats> = IndexMap::new();
    for pk in keys {
        let a = acc.shift_remove(&pk).unwrap();
        let since = if pk == DashPeriodKey::All { None } else { Some(pk.as_str()) };
        let rpm_idx = a.rpm_events;
        let rpm_idx_ref = &rpm_idx;
        let rpm_rows = move || rpm_idx_ref.iter().map(move |&i| (&events[i], if use_ts { timestamps_ms[i] } else { events[i].timestamp.js_ms() }));
        let mut agent_stats = finish(a.agent, GroupBy::Agent, SortBy::Cost, since);
        agent_stats.totals = a.totals.clone();
        let mut model_stats = finish(a.model, GroupBy::Model, SortBy::Cost, since);
        model_stats.totals = a.totals.clone();
        let mut day_stats = finish(a.day, GroupBy::Day, SortBy::Tokens, since);
        day_stats.totals = a.totals.clone();
        let mut hour_stats = finish(a.hour, GroupBy::Hour, SortBy::Tokens, since);
        hour_stats.totals = a.totals.clone();
        // Every group row carries its own peak RPM; groups without live rows
        // stay unset ("—"), never a misleading 0.
        for (stats, by) in [
            (&mut agent_stats, GroupBy::Agent),
            (&mut model_stats, GroupBy::Model),
            (&mut day_stats, GroupBy::Day),
            (&mut hour_stats, GroupBy::Hour),
        ] {
            let rpm_map = rpm_by_group_iter(
                rpm_rows(),
                by,
                RpmScope::Table,
                pk == DashPeriodKey::All && by == GroupBy::Model,
            );
            for g in stats.groups.iter_mut() {
                if let Some(peak) = rpm_map.get(&g.key) {
                    g.rpm = Some(*peak);
                }
            }
        }
        out.insert(
            pk,
            PrecomputedPeriodStats {
                built_at: now,
                by_group: ByGroup {
                    agent: agent_stats,
                    model: model_stats,
                    day: day_stats,
                    hour: hour_stats,
                },
                usage_rpm: compute_active_usage_rpm_iter(rpm_rows()),
            },
        );
    }
    out
}

/// `precomputeDashboardPeriods` with `nowMs = Date.now()`.
pub fn precompute_dashboard_periods_now(
    events: &[UsageEvent],
    timestamps_ms: &[f64],
    bounds: &HashMap<DashPeriodKey, Option<f64>>,
) -> IndexMap<DashPeriodKey, PrecomputedPeriodStats> {
    precompute_dashboard_periods(events, timestamps_ms, bounds, now_ms())
}

/// Count distinct UTC minute buckets that contain >=1 event.
///
/// Kept for the mean-rate calculation (`meanRpm`) and as a public helper; the
/// headline RPM is a peak minute, so idle gaps can no longer dilute it.
pub fn count_active_minutes(events: &[UsageEvent]) -> usize {
    if events.is_empty() {
        return 0;
    }
    let mut buckets: std::collections::HashSet<i64> = std::collections::HashSet::new();
    for e in events {
        let t = e.timestamp.js_ms();
        if !t.is_finite() {
            continue;
        }
        buckets.insert((t / 60_000.0).floor() as i64);
    }
    buckets.len()
}

/// Result of [`compute_active_usage_rpm`] (`computeActiveUsageRpm`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveUsageRpm {
    #[serde(with = "jsnum")]
    pub requests: f64,
    #[serde(with = "jsnum")]
    pub active_minutes: f64,
    /// Peak RPM = busiest single minute's request count (live rows only)
    #[serde(with = "jsnum")]
    pub rpm: f64,
    /// RPS equivalent = rpm / 60
    #[serde(with = "jsnum")]
    pub rps: f64,
    /// Average over active minutes (totalRequests / activeMinutes)
    #[serde(with = "jsnum")]
    pub mean_rpm: f64,
    pub method: &'static str,
    pub unit: &'static str,
}

/// Period PEAK RPM: the busiest single calendar minute, counted from **real
/// per-call rows only**. Estimated daily rollup rows are excluded from the
/// peak (one timestamp for a whole day's requests would fake a huge peak) but
/// still count toward `requests` and `activeMinutes`.
pub fn compute_active_usage_rpm(events: &[UsageEvent]) -> ActiveUsageRpm {
    compute_active_usage_rpm_iter(events.iter().map(|e| (e, e.timestamp.js_ms())))
}

/// Same as [`compute_active_usage_rpm`] over borrowed rows with precomputed
/// timestamps (ms), so no event clones or re-parsing are needed.
pub fn compute_active_usage_rpm_iter<'a, I>(rows: I) -> ActiveUsageRpm
where
    I: IntoIterator<Item = (&'a UsageEvent, f64)>,
{
    let mut requests = 0.0;
    // minute bucket -> requests in it (all rows)
    let mut per_minute: HashMap<i64, f64> = HashMap::new();
    // Live requests only: the peak ignores aggregated rollups.
    let mut live_per_minute: HashMap<i64, f64> = HashMap::new();

    for (e, t) in rows {
        let reqs = event_request_count(e);
        requests += reqs;
        if !t.is_finite() {
            continue;
        }
        let m = (t / 60_000.0).floor() as i64;
        *per_minute.entry(m).or_insert(0.0) += reqs;
        if e.estimated != Some(true) {
            *live_per_minute.entry(m).or_insert(0.0) += reqs;
        }
    }

    let mut rpm = 0.0;
    for count in live_per_minute.values() {
        if *count > rpm {
            rpm = *count;
        }
    }
    let active_minutes = per_minute.len() as f64;
    let mean_rpm = if active_minutes > 0.0 { requests / active_minutes } else { 0.0 };
    ActiveUsageRpm {
        requests,
        active_minutes,
        rpm,
        rps: rpm / 60.0,
        mean_rpm,
        method: "peak_minute",
        unit: "req/min",
    }
}

/// Whether zero-token / zero-cost probes count in [`rpm_by_group`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RpmScope {
    /// Probes count, matching the group's Requests column (default).
    Table,
    /// Probes dropped, matching the live rate used elsewhere.
    Live,
}

/// `Number(e.inputTokens) + ... <= 0 && !(Number(e.estimatedCost) > 0)`.
fn is_empty_probe(e: &UsageEvent) -> bool {
    let tok = or_zero(e.input_tokens)
        + or_zero(e.output_tokens)
        + or_zero(e.cache_read_tokens)
        + or_zero(e.cache_write_tokens);
    tok <= 0.0 && !matches!(e.estimated_cost, Some(c) if c > 0.0)
}

/// Per-group PEAK RPM for the breakdown table and the chart's RPM mode: the
/// busiest single calendar minute inside the group. Estimated daily rollups
/// are ALWAYS excluded, so groups with no live rows get no entry ("—").
///
/// Returns a map keyed by the same key used by `group_key`, so callers can
/// attach it straight onto `GroupRow::rpm`.
pub fn rpm_by_group(
    events: &[UsageEvent],
    by: GroupBy,
    timestamps_ms: Option<&[f64]>,
    scope: RpmScope,
    all_time_model_aliases: bool,
) -> HashMap<String, f64> {
    let n = events.len();
    let ts = timestamps_ms.filter(|t| t.len() == n);
    rpm_by_group_iter(
        events.iter().enumerate().map(|(i, e)| {
            let t = match ts {
                Some(t) => t[i],
                None => e.timestamp.js_ms(),
            };
            (e, t)
        }),
        by,
        scope,
        all_time_model_aliases,
    )
}

/// [`rpm_by_group`] over borrowed rows with precomputed timestamps (ms).
pub fn rpm_by_group_iter<'a, I>(
    rows: I,
    by: GroupBy,
    scope: RpmScope,
    all_time_model_aliases: bool,
) -> HashMap<String, f64>
where
    I: IntoIterator<Item = (&'a UsageEvent, f64)>,
{
    // key -> (minute bucket -> requests in that minute); peak resolved at the end.
    let mut acc: HashMap<String, HashMap<i64, f64>> = HashMap::new();

    for (e, t) in rows {
        // Aggregated rollups have no trustworthy minute — always excluded.
        if e.estimated == Some(true) {
            continue;
        }
        if !t.is_finite() {
            continue;
        }
        if scope == RpmScope::Live && is_empty_probe(e) {
            continue;
        }
        let key = group_key(e, by, Some(t), all_time_model_aliases);
        let minute = (t / 60_000.0).floor() as i64;
        *acc.entry(key).or_default().entry(minute).or_insert(0.0) += event_request_count(e);
    }

    let mut out = HashMap::new();
    for (key, minutes) in acc {
        let mut peak = 0.0;
        for count in minutes.values() {
            if *count > peak {
                peak = *count;
            }
        }
        out.insert(key, peak);
    }
    out
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerMinuteSlot {
    #[serde(with = "jsnum")]
    pub offset: f64,
    #[serde(with = "jsnum")]
    pub requests: f64,
}

/// Result of [`compute_live_request_rate`].
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveRequestRate {
    #[serde(with = "jsnum")]
    pub window_minutes: f64,
    /// Exact observation window in seconds (T in rate formula)
    #[serde(with = "jsnum")]
    pub window_seconds: f64,
    #[serde(with = "jsnum")]
    pub requests: f64,
    /// Mean requests per minute over the sliding window: RPM = N x 60 / T_seconds
    #[serde(with = "jsnum")]
    pub rpm: f64,
    /// Mean requests per second: RPS = N / T_seconds
    #[serde(with = "jsnum")]
    pub rps: f64,
    pub method: &'static str,
    pub unit: &'static str,
    /// Oldest minute first (offset = age in whole minutes); last slot = current partial minute
    pub per_minute: Vec<PerMinuteSlot>,
}

/// Live request rate over a sliding wall-clock window (TS default 3 minutes).
///
/// RPS = N / T_seconds, RPM = RPS x 60, where N = completed live API calls in
/// the open-closed interval (now-T, now] and T is the exact window length.
/// Estimated rollups and zero-token probes are excluded.
pub fn compute_live_request_rate(events: &[UsageEvent], window_minutes: f64, now: f64) -> LiveRequestRate {
    // Math.max(1, Math.min(60, Math.floor(windowMinutes) || 3))
    let fl = window_minutes.floor();
    let fl = if fl.is_nan() || fl == 0.0 { 3.0 } else { fl };
    let mins = fl.min(60.0).max(1.0);
    let mins_n = mins as usize;
    let window_ms = mins * 60_000.0;
    let window_seconds = window_ms / 1000.0;
    let start = now - window_ms;
    let mut per_minute: Vec<PerMinuteSlot> = (0..mins_n)
        .map(|i| PerMinuteSlot {
            offset: mins - 1.0 - i as f64, // mins-1 … 0 (0 = current partial minute)
            requests: 0.0,
        })
        .collect();

    let mut total = 0.0;
    for e in events {
        // Estimated daily / model rollups are not live API calls
        if e.estimated == Some(true) {
            continue;
        }
        let t = e.timestamp.js_ms();
        // Open-closed window (start, now] with small clock-skew tolerance
        if !t.is_finite() || t <= start || t > now + 5_000.0 {
            continue;
        }
        // Empty stream probes (0 tokens, no cost) are not billable API usage
        if is_empty_probe(e) {
            continue;
        }
        // Live row = one completed request; requestCount only when a true multi-call batch
        let reqs = match e.request_count {
            Some(rc) if rc.is_finite() && rc > 0.0 && rc <= 100.0 => rc.floor(),
            _ => 1.0,
        };
        total += reqs;
        let age_ms = now - t;
        let age_min = (mins - 1.0).min((age_ms / 60_000.0).floor().max(0.0));
        // ageMin 0 = current minute -> last slot; ageMin mins-1 = oldest -> first slot
        let idx = mins - 1.0 - age_min;
        if idx >= 0.0 && idx < mins {
            per_minute[idx as usize].requests += reqs;
        }
    }

    // Standard continuous mean rate (not integer minute buckets)
    let rps = if window_seconds > 0.0 { total / window_seconds } else { 0.0 };
    let rpm = rps * 60.0;

    LiveRequestRate {
        window_minutes: mins,
        window_seconds,
        requests: total,
        rpm,
        rps,
        method: "sliding_window_mean",
        unit: "req/min",
        per_minute,
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostReportAgent {
    pub agent: String,
    #[serde(with = "jsnum")]
    pub estimated_cost: f64,
    #[serde(with = "jsnum")]
    pub total_tokens: f64,
    #[serde(with = "jsnum")]
    pub share: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostReportModel {
    pub model: String,
    #[serde(with = "jsnum")]
    pub estimated_cost: f64,
    #[serde(with = "jsnum")]
    pub total_tokens: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostReport {
    pub currency: String,
    #[serde(with = "jsnum")]
    pub total_estimated_cost: f64,
    pub period: Period,
    pub by_agent: Vec<CostReportAgent>,
    pub by_model: Vec<CostReportModel>,
}

pub fn cost_report(events: &[UsageEvent], since: Option<&str>, until: Option<&str>) -> CostReport {
    let mut totals = empty_totals();
    let mut agents: IndexMap<String, GroupRow> = IndexMap::new();
    let mut models: IndexMap<String, GroupRow> = IndexMap::new();

    // Build both breakdowns together (one pricing pass per event). Note that
    // costReport prices the RAW event model, not the agent-normalized one.
    for event in events {
        let parts = price_cost_parts(
            event.model.as_deref(),
            or_zero(event.input_tokens),
            or_zero(event.output_tokens),
            or_zero(event.cache_read_tokens),
            or_zero(event.cache_write_tokens),
            event.estimated_cost,
        );
        let info = event_info(event);
        add_with_parts(&mut totals, event, &parts, &info);
        let ak = group_key(event, GroupBy::Agent, None, false);
        let agent_row = agents.entry(ak.clone()).or_insert_with(|| new_row(&ak));
        add_with_parts(&mut agent_row.totals, event, &parts, &info);
        let mk = group_key(event, GroupBy::Model, None, false);
        let model_row = models.entry(mk.clone()).or_insert_with(|| new_row(&mk));
        add_with_parts(&mut model_row.totals, event, &parts, &info);
    }

    let mut by_agent: Vec<GroupRow> = agents.into_values().collect();
    let mut by_model: Vec<GroupRow> = models.into_values().collect();
    sort_groups(&mut by_agent, SortBy::Cost);
    sort_groups(&mut by_model, SortBy::Cost);
    // `totals.estimatedCost || 1`
    let total = if totals.estimated_cost == 0.0 || totals.estimated_cost.is_nan() {
        1.0
    } else {
        totals.estimated_cost
    };
    CostReport {
        currency: "USD".to_string(),
        total_estimated_cost: totals.estimated_cost,
        period: Period {
            since: since.map(|s| s.to_string()),
            until: until.map(|s| s.to_string()),
        },
        by_agent: by_agent
            .into_iter()
            .map(|g| CostReportAgent {
                agent: g.key,
                estimated_cost: g.totals.estimated_cost,
                total_tokens: g.totals.total_tokens,
                share: g.totals.estimated_cost / total,
            })
            .collect(),
        by_model: by_model
            .into_iter()
            .map(|g| CostReportModel {
                model: g.key,
                estimated_cost: g.totals.estimated_cost,
                total_tokens: g.totals.total_tokens,
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::PricingStatus;
    use crate::util::js_date_parse;

    fn sample() -> Vec<UsageEvent> {
        vec![
            UsageEvent {
                id: "1".into(),
                agent: AgentId::Cursor,
                model: Some("gpt-4.1".into()),
                timestamp: "2026-07-11T10:00:00.000Z".into(),
                input_tokens: 1000.0,
                output_tokens: 200.0,
                total_tokens: 1200.0,
                estimated_cost: Some(0.5),
                currency: "USD".into(),
                pricing_status: PricingStatus::Priced,
                workspace: None,
                source_path: "x".into(),
                ..Default::default()
            },
            UsageEvent {
                id: "2".into(),
                agent: AgentId::Grok,
                model: Some("grok-4.5".into()),
                timestamp: "2026-07-11T11:00:00.000Z".into(),
                input_tokens: 2000.0,
                output_tokens: 400.0,
                total_tokens: 2400.0,
                estimated_cost: Some(1.2),
                currency: "USD".into(),
                pricing_status: PricingStatus::Priced,
                workspace: None,
                source_path: "y".into(),
                ..Default::default()
            },
        ]
    }

    fn cost(events: &[UsageEvent], by: GroupBy) -> StatsResult {
        aggregate_simple(events, by, SortBy::Cost)
    }

    fn find<'a>(r: &'a StatsResult, key: &str) -> Option<&'a GroupRow> {
        r.groups.iter().find(|g| g.key == key)
    }

    #[test]
    fn aggregate_by_agent_sorts_by_cost() {
        let r = cost(&sample(), GroupBy::Agent);
        assert_eq!(r.groups[0].key, "grok");
        assert_eq!(r.totals.total_tokens, 3600.0);
        assert!((r.totals.estimated_cost - 1.7).abs() < 1e-9);
        assert_eq!(r.totals.event_count, 2.0, "default 1 request per event");
    }

    // The TS test asserts the raw "gpt-4.1" key; the TS source (and this port)
    // display-groups with dashes replaced by spaces ("gpt 4.1").
    #[test]
    fn aggregate_event_count_sums_request_count() {
        let s = sample();
        let events = vec![
            UsageEvent { id: "d1".into(), request_count: Some(90.0), estimated_cost: Some(4.5), ..s[0].clone() },
            UsageEvent { id: "d2".into(), request_count: Some(10.0), estimated_cost: Some(0.5), ..s[1].clone() },
        ];
        let r = cost(&events, GroupBy::Model);
        assert_eq!(r.totals.event_count, 100.0);
        assert_eq!(find(&r, "gpt 4.1").map(|g| g.totals.event_count), Some(90.0));
        assert_eq!(find(&r, "grok 4.5").map(|g| g.totals.event_count), Some(10.0));
    }

    #[test]
    fn aggregate_by_model_merges_qwencoder_into_qwen38_max() {
        let s = sample();
        let events = vec![
            UsageEvent {
                id: "qwen".into(),
                model: Some("qwen3.8 max".into()),
                request_count: Some(5.0),
                total_tokens: 100.0,
                ..s[0].clone()
            },
            UsageEvent {
                id: "qwencoder".into(),
                model: Some("qwencoder-qwen3.8-max".into()),
                request_count: Some(3.0),
                total_tokens: 60.0,
                ..s[0].clone()
            },
        ];
        let r = cost(&events, GroupBy::Model);
        assert_eq!(r.groups.len(), 1);
        assert_eq!(r.groups[0].key, "qwen3.8 max");
        assert_eq!(r.groups[0].totals.event_count, 8.0);
        assert_eq!(r.groups[0].totals.total_tokens, 160.0);
    }

    #[test]
    fn cost_report_matches_agent_and_model_aggregates() {
        let s = sample();
        let mut events = s.clone();
        events.push(UsageEvent {
            id: "3".into(),
            model: Some("gpt-4.1 (openai-compatible-responses)".into()),
            input_tokens: 50.0,
            output_tokens: 50.0,
            total_tokens: 100.0,
            estimated_cost: Some(0.25),
            request_count: Some(3.0),
            ..s[0].clone()
        });
        let agent = aggregate(&events, GroupBy::Agent, SortBy::Cost, Some("7d"), Some("until"), None, false);
        let model = aggregate(&events, GroupBy::Model, SortBy::Cost, Some("7d"), Some("until"), None, false);
        let report = cost_report(&events, Some("7d"), Some("until"));
        let total = if agent.totals.estimated_cost == 0.0 { 1.0 } else { agent.totals.estimated_cost };

        assert_eq!(report.total_estimated_cost, agent.totals.estimated_cost);
        assert_eq!(
            report.period,
            Period { since: Some("7d".into()), until: Some("until".into()) }
        );
        assert_eq!(
            report.by_agent,
            agent
                .groups
                .iter()
                .map(|g| CostReportAgent {
                    agent: g.key.clone(),
                    estimated_cost: g.totals.estimated_cost,
                    total_tokens: g.totals.total_tokens,
                    share: g.totals.estimated_cost / total,
                })
                .collect::<Vec<_>>()
        );
        assert_eq!(
            report.by_model,
            model
                .groups
                .iter()
                .map(|g| CostReportModel {
                    model: g.key.clone(),
                    estimated_cost: g.totals.estimated_cost,
                    total_tokens: g.totals.total_tokens,
                })
                .collect::<Vec<_>>()
        );
    }

    fn live(base: &UsageEvent, id: &str, ts: &str, rc: f64) -> UsageEvent {
        UsageEvent {
            id: id.into(),
            timestamp: ts.into(),
            request_count: Some(rc),
            estimated: Some(false),
            ..base.clone()
        }
    }

    #[test]
    fn compute_active_usage_rpm_returns_the_peak_minute() {
        let s = sample();
        let events = vec![
            live(&s[0], "a1", "2026-07-28T01:00:10.000Z", 4.0),
            live(&s[0], "a2", "2026-07-28T01:00:40.000Z", 1.0),
            live(&s[0], "b1", "2026-07-28T03:15:00.000Z", 5.0),
        ];
        assert_eq!(count_active_minutes(&events), 2);
        let r = compute_active_usage_rpm(&events);
        assert_eq!(r.method, "peak_minute");
        assert_eq!(r.requests, 10.0);
        assert_eq!(r.active_minutes, 2.0);
        assert_eq!(r.rpm, 5.0);
        assert_eq!(r.mean_rpm, 5.0);
        assert!((r.rps - 5.0 / 60.0).abs() < 1e-9);
    }

    #[test]
    fn peak_rpm_beats_the_mean_when_traffic_is_bursty() {
        let s = sample();
        let events = vec![
            live(&s[0], "burst", "2026-07-28T01:00:00.000Z", 30.0),
            live(&s[0], "b", "2026-07-28T01:05:00.000Z", 1.0),
            live(&s[0], "c", "2026-07-28T01:10:00.000Z", 1.0),
            live(&s[0], "d", "2026-07-28T01:15:00.000Z", 1.0),
        ];
        let r = compute_active_usage_rpm(&events);
        assert_eq!(r.requests, 33.0);
        assert_eq!(r.active_minutes, 4.0);
        assert_eq!(r.mean_rpm, 33.0 / 4.0);
        assert_eq!(r.rpm, 30.0);
        assert_ne!(r.rpm, r.mean_rpm);
    }

    #[test]
    fn active_minutes_counts_only_minutes_that_carried_requests() {
        let s = sample();
        let events = vec![
            live(&s[0], "m1a", "2026-07-28T09:00:05.000Z", 1.0),
            live(&s[0], "m1b", "2026-07-28T09:00:35.000Z", 1.0),
            live(&s[0], "m1c", "2026-07-28T09:00:59.000Z", 1.0),
            live(&s[0], "m2", "2026-07-28T21:30:00.000Z", 1.0),
        ];
        let r = compute_active_usage_rpm(&events);
        assert_eq!(r.active_minutes, 2.0);
        assert_eq!(r.requests, 4.0);
        assert!(r.active_minutes < 1440.0);
        assert_eq!(r.rpm, 3.0);
    }

    #[test]
    fn daily_rollup_row_inflates_active_minutes_by_exactly_one() {
        let s = sample();
        let mut rollup = live(&s[0], "rollup", "2026-07-28T23:59:00.000Z", 4692.0);
        rollup.estimated = Some(true);
        let events = vec![live(&s[0], "live", "2026-07-28T09:00:10.000Z", 1.0), rollup];
        let r = compute_active_usage_rpm(&events);
        assert_eq!(r.active_minutes, 2.0);
        assert_eq!(r.rpm, 1.0);
        assert_eq!(r.requests, 4693.0);
    }

    #[test]
    fn compute_live_request_rate_uses_sliding_window_mean() {
        let s = sample();
        let now = js_date_parse("2026-07-27T12:00:00.000Z");
        let iso = |ms: f64| to_iso_string(ms).unwrap();
        let mut daily_fat = live(&s[0], "daily-fat", &iso(now - 20_000.0), 500.0);
        daily_fat.estimated = Some(true);
        let mut probe = live(&s[0], "probe", &iso(now - 10_000.0), 1.0);
        probe.input_tokens = 0.0;
        probe.output_tokens = 0.0;
        probe.total_tokens = 0.0;
        probe.estimated_cost = Some(0.0);
        let events = vec![
            live(&s[0], "live-1", &iso(now - 30_000.0), 2.0),
            live(&s[0], "live-2", &iso(now - 90_000.0), 3.0),
            live(&s[0], "live-3", &iso(now - 150_000.0), 1.0),
            live(&s[0], "old", &iso(now - 400_000.0), 100.0),
            daily_fat,
            probe,
        ];
        let r = compute_live_request_rate(&events, 3.0, now);
        assert_eq!(r.window_minutes, 3.0);
        assert_eq!(r.window_seconds, 180.0);
        assert_eq!(r.method, "sliding_window_mean");
        assert_eq!(r.unit, "req/min");
        assert_eq!(r.requests, 6.0);
        assert!((r.rpm - (6.0 * 60.0) / 180.0).abs() < 1e-9);
        assert!((r.rps - 6.0 / 180.0).abs() < 1e-9);
        assert_eq!(r.per_minute.len(), 3);
        assert_eq!(r.per_minute[0].offset, 2.0);
        assert_eq!(r.per_minute[0].requests, 1.0);
        assert_eq!(r.per_minute[1].requests, 3.0);
        assert_eq!(r.per_minute[2].requests, 2.0);
    }

    #[test]
    fn aggregate_by_model_merges_names_with_provider_parentheses() {
        let s = sample();
        let mk = |id: &str, model: &str, tok: f64, cost: f64, inp: f64, out: f64| UsageEvent {
            id: id.into(),
            model: Some(model.into()),
            total_tokens: tok,
            estimated_cost: Some(cost),
            input_tokens: inp,
            output_tokens: out,
            ..s[0].clone()
        };
        let events = vec![
            mk("a", "gpt-5.5 (openai-compatible-responses-edd706dd-4c64-4148-ba97-f5bddf8c0cfc)", 100.0, 1.0, 80.0, 20.0),
            mk("b", "gpt-5.5|openai-compatible-chat-aa9b60d1", 50.0, 0.5, 40.0, 10.0),
            mk("c", "gpt-5.5", 30.0, 0.3, 20.0, 10.0),
        ];
        let r = cost(&events, GroupBy::Model);
        let gpt = find(&r, "gpt 5.5").unwrap_or_else(|| {
            panic!(
                "expected gpt 5.5 group, got {}",
                r.groups.iter().map(|g| g.key.clone()).collect::<Vec<_>>().join(",")
            )
        });
        assert_eq!(gpt.totals.event_count, 3.0);
        assert_eq!(gpt.totals.total_tokens, 180.0);
        assert!((gpt.totals.estimated_cost - 1.8).abs() < 1e-9);
    }

    #[test]
    fn aggregate_by_model_merges_case_variants_into_one_lowercase_key() {
        let s = sample();
        let mk = |id: &str, model: &str, tok: f64, cost: f64, inp: f64, out: f64| UsageEvent {
            id: id.into(),
            model: Some(model.into()),
            total_tokens: tok,
            estimated_cost: Some(cost),
            input_tokens: inp,
            output_tokens: out,
            ..s[0].clone()
        };
        let events = vec![
            mk("k1", "kimi-k3", 100.0, 1.0, 80.0, 20.0),
            mk("k2", "Kimi-k3", 50.0, 0.5, 40.0, 10.0),
            mk("k3", "KIMI-K3", 30.0, 0.3, 20.0, 10.0),
            mk("x1", "xlab", 10.0, 0.1, 8.0, 2.0),
            mk("x2", "XLab", 10.0, 0.1, 8.0, 2.0),
        ];
        let r = cost(&events, GroupBy::Model);
        let kimi = find(&r, "kimi k3").expect("single kimi k3 group");
        assert_eq!(kimi.totals.event_count, 3.0);
        assert_eq!(kimi.totals.total_tokens, 180.0);
        // "xlab" normalizes to gpt-5.5, same as the TS source.
        let xlab = find(&r, "gpt 5.5").expect("xlab -> gpt 5.5 group");
        assert_eq!(xlab.totals.event_count, 2.0);
        assert_eq!(r.groups.iter().filter(|g| g.key.to_lowercase() == "kimi k3").count(), 1);
    }

    fn mk_live(base: &UsageEvent, id: &str, ts: &str, rc: f64) -> UsageEvent {
        live(base, id, ts, rc)
    }

    #[test]
    fn rpm_by_group_reports_each_hours_peak_minute() {
        let s = sample();
        let events = vec![
            mk_live(&s[0], "h2a", "2026-07-28T02:00:10.000Z", 1.0),
            mk_live(&s[0], "h2b", "2026-07-28T02:04:50.000Z", 1.0),
            mk_live(&s[0], "h3a", "2026-07-28T03:10:00.000Z", 4.0),
            mk_live(&s[0], "h3b", "2026-07-28T03:10:30.000Z", 2.0),
            mk_live(&s[0], "h4a", "2026-07-28T04:00:05.000Z", 20.0),
            mk_live(&s[0], "h4b", "2026-07-28T04:30:00.000Z", 2.0),
        ];
        let by_hour = rpm_by_group(&events, GroupBy::Hour, None, RpmScope::Table, false);
        assert_eq!(by_hour.get("2026-07-28T02:00"), Some(&1.0));
        assert_eq!(by_hour.get("2026-07-28T03:00"), Some(&6.0));
        assert_eq!(by_hour.get("2026-07-28T04:00"), Some(&20.0));
        assert_ne!(by_hour.get("2026-07-28T04:00"), Some(&11.0));
    }

    #[test]
    fn rollups_never_contribute_to_peak_rpm_but_inflate_requests() {
        let s = sample();
        let mut rollup = mk_live(&s[0], "rollup", "2026-07-28T05:30:00.000Z", 50.0);
        rollup.estimated = Some(true);
        let mut probe = mk_live(&s[0], "probe", "2026-07-28T05:45:00.000Z", 1.0);
        probe.input_tokens = 0.0;
        probe.output_tokens = 0.0;
        probe.cache_read_tokens = 0.0;
        probe.cache_write_tokens = 0.0;
        probe.total_tokens = 0.0;
        probe.estimated_cost = Some(0.0);
        let events = vec![mk_live(&s[0], "real", "2026-07-28T05:00:10.000Z", 1.0), rollup, probe];

        let live_hour = rpm_by_group(&events, GroupBy::Hour, None, RpmScope::Live, false);
        assert_eq!(live_hour.get("2026-07-28T05:00"), Some(&1.0));
        let live_day = rpm_by_group(&events, GroupBy::Day, None, RpmScope::Live, false);
        assert_eq!(live_day.get("2026-07-28"), Some(&1.0));

        let table_hour = rpm_by_group(&events, GroupBy::Hour, None, RpmScope::Table, false);
        assert_eq!(table_hour.get("2026-07-28T05:00"), Some(&1.0));

        let hour_stats = aggregate_simple(&events, GroupBy::Hour, SortBy::Tokens);
        let row = find(&hour_stats, "2026-07-28T05:00").unwrap();
        assert_eq!(row.totals.event_count, 52.0);
        assert_eq!(row.rpm, Some(1.0));

        let agent_stats = cost(&events, GroupBy::Agent);
        assert!(!agent_stats.groups.is_empty());
        for g in &agent_stats.groups {
            assert!(g.rpm.unwrap_or(0.0) > 0.0);
        }
    }

    #[test]
    fn rollup_only_groups_report_no_rpm() {
        let s = sample();
        let mk = |id: &str, ts: &str, estimated: bool, rc: f64| UsageEvent {
            id: id.into(),
            model: Some("claude-sonnet".into()),
            timestamp: ts.into(),
            request_count: Some(rc),
            estimated: Some(estimated),
            ..s[0].clone()
        };
        let only_rollup = vec![UsageEvent {
            total_tokens: 1_177_887.0,
            input_tokens: 1_000_000.0,
            ..mk("r1", "2026-07-28T05:00:00.000Z", true, 157.0)
        }];
        let s1 = cost(&only_rollup, GroupBy::Model);
        let row1 = &s1.groups[0];
        assert_eq!(row1.totals.event_count, 157.0);
        assert_eq!(row1.rpm, None);
        assert_eq!(
            rpm_by_group(&only_rollup, GroupBy::Model, None, RpmScope::Table, false).get("claude-sonnet"),
            None
        );

        let mixed = vec![
            mk("m1", "2026-07-28T02:00:00.000Z", true, 4692.0),
            mk("m2", "2026-07-28T02:00:10.000Z", false, 3.0),
            mk("m3", "2026-07-28T02:05:40.000Z", false, 5.0),
        ];
        let row2 = &cost(&mixed, GroupBy::Model).groups[0];
        assert_eq!(row2.totals.event_count, 4700.0);
        assert_eq!(row2.rpm, Some(5.0));
        assert_ne!(row2.rpm, Some(4692.0));
    }

    #[test]
    fn agent_rpm_is_scoped_per_group() {
        let s = sample();
        let mk = |id: &str, agent: AgentId, ts: &str, rc: f64| UsageEvent {
            agent,
            ..mk_live(&s[0], id, ts, rc)
        };
        let events = vec![
            mk("a1", AgentId::Codex, "2026-07-28T09:00:05.000Z", 8.0),
            mk("b1", AgentId::Cline, "2026-07-28T09:30:00.000Z", 1.0),
        ];
        let stats = cost(&events, GroupBy::Agent);
        assert_eq!(find(&stats, "codex").and_then(|g| g.rpm), Some(8.0));
        assert_eq!(find(&stats, "cline").and_then(|g| g.rpm), Some(1.0));
    }

    // ---- cache-reported.test.ts ----

    fn ev(id: &str, agent: AgentId, cache_read: f64, cache_reported: Option<bool>) -> UsageEvent {
        UsageEvent {
            id: id.into(),
            agent,
            model: Some("claude-fable-5".into()),
            timestamp: "2026-10-09T01:00:00.000Z".into(),
            input_tokens: 100.0,
            output_tokens: 10.0,
            cache_read_tokens: cache_read,
            cache_write_tokens: 0.0,
            total_tokens: 100.0 + 10.0 + cache_read,
            estimated_cost: Some(0.01),
            currency: "USD".into(),
            pricing_status: PricingStatus::Priced,
            workspace: None,
            source_path: "x".into(),
            cache_reported,
            ..Default::default()
        }
    }

    #[test]
    fn cache_reported_events_counts_only_rows_that_reported_cache() {
        let r = cost(
            &[
                ev("a", AgentId::Dsh, 500.0, Some(true)),
                ev("b", AgentId::Dsh, 0.0, Some(true)),
                ev("c", AgentId::Dsh, 300.0, None),
            ],
            GroupBy::Agent,
        );
        let row = find(&r, "dsh").unwrap();
        assert_eq!(row.totals.cache_reported_events, Some(2.0), "only the two flagged rows count");
        assert_eq!(row.totals.cache_read_tokens, 800.0);

        let r2 = cost(&[ev("d", AgentId::Litellm, 0.0, None), ev("e", AgentId::Litellm, 0.0, None)], GroupBy::Agent);
        assert_eq!(find(&r2, "litellm").unwrap().totals.cache_reported_events, None);
    }

    #[test]
    fn cache_reported_events_is_absent_when_nothing_reported() {
        let r = cost(&[ev("f", AgentId::Grok, 0.0, None)], GroupBy::Agent);
        let row = find(&r, "grok").unwrap();
        assert!(row.totals.cache_reported_events.unwrap_or(0.0) == 0.0);
        let v = serde_json::to_value(row).unwrap();
        assert!(v.get("cacheReportedEvents").is_none());
    }

    // ---- extras ----

    #[test]
    fn precompute_periods_filters_and_groups() {
        let s = sample();
        let now = js_date_parse("2026-07-11T12:00:00.000Z");
        let ts: Vec<f64> = s.iter().map(|e| e.timestamp.js_ms()).collect();
        let mut bounds = HashMap::new();
        bounds.insert(DashPeriodKey::Today, Some(js_date_parse("2026-07-11T10:30:00.000Z")));
        bounds.insert(DashPeriodKey::All, None);
        let out = precompute_dashboard_periods(&s, &ts, &bounds, now);
        let today = &out[&DashPeriodKey::Today];
        assert_eq!(today.by_group.agent.totals.total_tokens, 2400.0);
        assert_eq!(today.by_group.agent.period.since.as_deref(), Some("today"));
        let all = &out[&DashPeriodKey::All];
        assert_eq!(all.by_group.agent.totals.total_tokens, 3600.0);
        assert_eq!(all.by_group.agent.period.since, None);
        // hour series only for today/24h
        assert!(all.by_group.hour.groups.is_empty());
        assert_eq!(today.by_group.hour.groups.len(), 1);
    }

    #[test]
    fn totals_json_shape_matches_ts_empty_totals() {
        let r = cost(&[], GroupBy::Agent);
        let v = serde_json::to_value(&r.totals).unwrap();
        assert_eq!(v["estimatedPricing"], false);
        assert_eq!(v["inputCost"].to_string(), "0");
        assert_eq!(v["cacheBilledTokens"].to_string(), "0");
        assert_eq!(v["cacheFreeTokens"].to_string(), "0");
        assert!(v.get("cacheReportedEvents").is_none());
    }
}
