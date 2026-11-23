//! Port of `src/types.ts`.
//!
//! JSON field names are identical to the TypeScript version (camelCase). All
//! numeric fields are `f64` (JS `number`); they serialize as integers when the
//! value is integral so on-disk files stay byte-compatible with the TS build.

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;

/// Lenient number (de)serialization helpers shared by the data model.
///
/// * serialize: integral finite values are written as integers (`12`, not
///   `12.0`) exactly like `JSON.stringify`; non-finite values become `null`.
/// * deserialize: accepts numbers, numeric strings, booleans and `null`
///   (`null` -> `0`) so files written by the TS build always load.
pub mod jsnum {
    use super::*;

    #[derive(Deserialize)]
    #[serde(untagged)]
    enum NumLike {
        Num(f64),
        Str(String),
        Bool(bool),
    }

    fn to_f64(v: NumLike) -> f64 {
        match v {
            NumLike::Num(n) => n,
            NumLike::Str(s) => crate::util::js_number_from_str(&s),
            NumLike::Bool(b) => {
                if b {
                    1.0
                } else {
                    0.0
                }
            }
        }
    }

    pub fn ser<S: Serializer>(v: &f64, s: S) -> Result<S::Ok, S::Error> {
        if !v.is_finite() {
            return s.serialize_none();
        }
        if v.fract() == 0.0 && v.abs() < 9.007_199_254_740_992e15 {
            // `-0` serializes as `0` in JS.
            s.serialize_i64(*v as i64)
        } else {
            // ryu (serde_json's default) diverges from `Number::toString`
            // below 1e-5 and from 9e15 upwards; emit those verbatim.
            let a = v.abs();
            if a < 1e-5 || a >= 9e15 {
                let txt = crate::util::js_num_to_string(*v);
                if let Ok(raw) = serde_json::value::RawValue::from_string(txt) {
                    return serde::Serialize::serialize(&raw, s);
                }
            }
            s.serialize_f64(*v)
        }
    }

    /// `#[serde(with = "jsnum")]` entry points.
    pub fn serialize<S: Serializer>(v: &f64, s: S) -> Result<S::Ok, S::Error> {
        ser(v, s)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
        de(d)
    }

    pub fn ser_opt<S: Serializer>(v: &Option<f64>, s: S) -> Result<S::Ok, S::Error> {
        match v {
            Some(n) => ser(n, s),
            None => s.serialize_none(),
        }
    }

    pub fn de<'de, D: Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
        let v = Option::<NumLike>::deserialize(d)?;
        Ok(match v {
            None => 0.0,
            Some(v) => {
                let n = to_f64(v);
                if n.is_nan() {
                    0.0
                } else {
                    n
                }
            }
        })
    }

    pub fn de_opt<'de, D: Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
        let v = Option::<NumLike>::deserialize(d)?;
        Ok(v.map(to_f64).filter(|n| !n.is_nan()))
    }
}

macro_rules! agent_ids {
    ($($variant:ident => $s:literal),+ $(,)?) => {
        /// Agent identifier. String ids are identical to the TS `AgentId` union.
        ///
        /// `xlabrouter` is a deprecated legacy id normalized to `routerlab` on
        /// load (see `util::normalize_agent_id`). Unknown ids deserialize to
        /// [`AgentId::Custom`].
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub enum AgentId {
            $($variant),+
        }

        impl AgentId {
            /// Every id, in the same order as the TS union.
            pub const ALL: &'static [AgentId] = &[$(AgentId::$variant),+];

            pub fn as_str(&self) -> &'static str {
                match self {
                    $(AgentId::$variant => $s),+
                }
            }

            /// Exact (case-sensitive) lookup of a known id string.
            pub fn from_id(s: &str) -> Option<AgentId> {
                match s {
                    $($s => Some(AgentId::$variant),)+
                    _ => None,
                }
            }
        }
    };
}

agent_ids! {
    ClaudeCode => "claude-code",
    Codex => "codex",
    Cursor => "cursor",
    Windsurf => "windsurf",
    Grok => "grok",
    Gemini => "gemini",
    Opencode => "opencode",
    Dsh => "dsh",
    Copilot => "copilot",
    Hermes => "hermes",
    Openclaw => "openclaw",
    Pi => "pi",
    Kimi => "kimi",
    Qwen => "qwen",
    Qwencoder => "qwencoder",
    Droid => "droid",
    Amp => "amp",
    Goose => "goose",
    Cline => "cline",
    Roocode => "roocode",
    Kilocode => "kilocode",
    Antigravity => "antigravity",
    Warp => "warp",
    Trae => "trae",
    Zed => "zed",
    Codebuff => "codebuff",
    Mux => "mux",
    Crush => "crush",
    Kiro => "kiro",
    Gjc => "gjc",
    Jcode => "jcode",
    Commandcode => "commandcode",
    Junie => "junie",
    Zcode => "zcode",
    Opencodereview => "opencodereview",
    Codebuddy => "codebuddy",
    Workbuddy => "workbuddy",
    Aider => "aider",
    Continue => "continue",
    Devin => "devin",
    Ollama => "ollama",
    Codewhale => "codewhale",
    Mimocode => "mimocode",
    Qoder => "qoder",
    Iflow => "iflow",
    Blackbox => "blackbox",
    Forge => "forge",
    Void => "void",
    AmazonQ => "amazon-q",
    NineRouter => "9router",
    Routerlab => "routerlab",
    Xlabrouter => "xlabrouter",
    Litellm => "litellm",
    Custom => "custom",
}

impl Default for AgentId {
    fn default() -> Self {
        AgentId::Custom
    }
}

impl fmt::Display for AgentId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for AgentId {
    type Err = std::convert::Infallible;
    /// Lossy: unknown ids map to `Custom`.
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(AgentId::from_id(s).unwrap_or(AgentId::Custom))
    }
}

impl Serialize for AgentId {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for AgentId {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> serde::de::Visitor<'de> for V {
            type Value = AgentId;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("an agent id string")
            }
            fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<AgentId, E> {
                Ok(AgentId::from_id(v).unwrap_or(AgentId::Custom))
            }
        }
        d.deserialize_str(V)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PricingStatus {
    Priced,
    UnknownModel,
    ZeroRate,
    Estimated,
}

impl Default for PricingStatus {
    fn default() -> Self {
        PricingStatus::Priced
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageEvent {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub agent: AgentId,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub timestamp: String,
    #[serde(default, with = "jsnum")]
    pub input_tokens: f64,
    #[serde(default, with = "jsnum")]
    pub output_tokens: f64,
    #[serde(default, with = "jsnum")]
    pub cache_read_tokens: f64,
    #[serde(default, with = "jsnum")]
    pub cache_write_tokens: f64,
    #[serde(default, with = "jsnum")]
    pub total_tokens: f64,
    #[serde(default, serialize_with = "jsnum::ser_opt", deserialize_with = "jsnum::de_opt")]
    pub estimated_cost: Option<f64>,
    #[serde(default)]
    pub currency: String,
    #[serde(default)]
    pub pricing_status: PricingStatus,
    #[serde(default)]
    pub workspace: Option<String>,
    #[serde(default)]
    pub source_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated: Option<bool>,
    // Serialization order follows TS `sanitizeEvents` (estimated, cacheReported,
    // machineScope, requestCount) so scan-cache.json is written key-for-key the
    // same as the TypeScript build.
    /// True when the source record actually exposed cache fields (even as zero).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_reported: Option<bool>,
    /// Runtime/persisted provenance scope used to keep foreign-machine restores
    /// separate from local usage during deduplication and high-water merges.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine_scope: Option<String>,
    /// Real API request count represented by this row (defaults to 1).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "jsnum::ser_opt",
        deserialize_with = "jsnum::de_opt"
    )]
    pub request_count: Option<f64>,
    /// True when the row's billed cost is measurably BELOW what its own token
    /// counts imply at the rate table (billed on a cheaper rate card).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_parity_gap: Option<bool>,
}

impl Default for UsageEvent {
    fn default() -> Self {
        UsageEvent {
            id: String::new(),
            agent: AgentId::Custom,
            model: None,
            timestamp: String::new(),
            input_tokens: 0.0,
            output_tokens: 0.0,
            cache_read_tokens: 0.0,
            cache_write_tokens: 0.0,
            total_tokens: 0.0,
            estimated_cost: None,
            currency: "USD".to_string(),
            pricing_status: PricingStatus::Priced,
            workspace: None,
            source_path: String::new(),
            estimated: None,
            machine_scope: None,
            request_count: None,
            cache_reported: None,
            cost_parity_gap: None,
        }
    }
}

impl UsageEvent {
    /// `event.requestCount ?? 1`
    pub fn request_count_or_1(&self) -> f64 {
        self.request_count.unwrap_or(1.0)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TokenTotals {
    #[serde(default, with = "jsnum")]
    pub input_tokens: f64,
    #[serde(default, with = "jsnum")]
    pub output_tokens: f64,
    #[serde(default, with = "jsnum")]
    pub cache_read_tokens: f64,
    #[serde(default, with = "jsnum")]
    pub cache_write_tokens: f64,
    #[serde(default, with = "jsnum")]
    pub total_tokens: f64,
    #[serde(default, with = "jsnum")]
    pub estimated_cost: f64,
    /// At least one model in this bucket used a paid reference rate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated_pricing: Option<bool>,
    /// Rate-weighted cost parts (not token-share of total).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "jsnum::ser_opt",
        deserialize_with = "jsnum::de_opt"
    )]
    pub input_cost: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "jsnum::ser_opt",
        deserialize_with = "jsnum::de_opt"
    )]
    pub cache_cost: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "jsnum::ser_opt",
        deserialize_with = "jsnum::de_opt"
    )]
    pub output_cost: Option<f64>,
    #[serde(default)]
    pub currency: String,
    #[serde(default, with = "jsnum")]
    pub event_count: f64,
    /// Cache-read tokens the bucket's rate table actually charges a discount on.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "jsnum::ser_opt",
        deserialize_with = "jsnum::de_opt"
    )]
    pub cache_billed_tokens: Option<f64>,
    /// Cache-read tokens that earned no discount
    /// (`cacheFreeTokens + cacheBilledTokens === cacheReadTokens`).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "jsnum::ser_opt",
        deserialize_with = "jsnum::de_opt"
    )]
    pub cache_free_tokens: Option<f64>,
    /// Events whose source actually reported a cache field (read or write).
    /// Declared last: the TS object gains this key after the initial literal,
    /// so it serializes after `cacheFreeTokens`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "jsnum::ser_opt",
        deserialize_with = "jsnum::de_opt"
    )]
    pub cache_reported_events: Option<f64>,
}

impl Default for TokenTotals {
    fn default() -> Self {
        TokenTotals {
            input_tokens: 0.0,
            output_tokens: 0.0,
            cache_read_tokens: 0.0,
            cache_write_tokens: 0.0,
            total_tokens: 0.0,
            estimated_cost: 0.0,
            estimated_pricing: None,
            input_cost: None,
            cache_cost: None,
            output_cost: None,
            currency: "USD".to_string(),
            event_count: 0.0,
            cache_reported_events: None,
            cache_billed_tokens: None,
            cache_free_tokens: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GroupRow {
    pub key: String,
    #[serde(flatten)]
    pub totals: TokenTotals,
    /// Peak RPM inside this bucket: the busiest single calendar minute's
    /// request count (hour/day/agent/model rows alike).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "jsnum::ser_opt",
        deserialize_with = "jsnum::de_opt"
    )]
    pub rpm: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GroupBy {
    Agent,
    Model,
    Day,
    Hour,
}

impl GroupBy {
    pub fn as_str(&self) -> &'static str {
        match self {
            GroupBy::Agent => "agent",
            GroupBy::Model => "model",
            GroupBy::Day => "day",
            GroupBy::Hour => "hour",
        }
    }

    pub fn parse(s: &str) -> Option<GroupBy> {
        match s {
            "agent" => Some(GroupBy::Agent),
            "model" => Some(GroupBy::Model),
            "day" => Some(GroupBy::Day),
            "hour" => Some(GroupBy::Hour),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Period {
    #[serde(default)]
    pub since: Option<String>,
    #[serde(default)]
    pub until: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StatsResult {
    pub totals: TokenTotals,
    pub groups: Vec<GroupRow>,
    pub group_by: GroupBy,
    pub period: Period,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub id: AgentId,
    pub label: String,
    pub detected: bool,
    pub enabled: bool,
    pub paths: Vec<String>,
    #[serde(default)]
    pub last_event_at: Option<String>,
    #[serde(default, with = "jsnum")]
    pub event_count: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRate {
    #[serde(rename = "inputPer1M", default, with = "jsnum")]
    pub input_per_1m: f64,
    #[serde(rename = "outputPer1M", default, with = "jsnum")]
    pub output_per_1m: f64,
    #[serde(
        rename = "cacheReadPer1M",
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "jsnum::ser_opt",
        deserialize_with = "jsnum::de_opt"
    )]
    pub cache_read_per_1m: Option<f64>,
    #[serde(
        rename = "cacheWritePer1M",
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "jsnum::ser_opt",
        deserialize_with = "jsnum::de_opt"
    )]
    pub cache_write_per_1m: Option<f64>,
    /// This rate is a paid reference proxy for an anonymous or free-only alias.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated: Option<bool>,
    /// When prompt tokens (uncached input + cache read) reach this threshold,
    /// all token rates are billed at 2x (xAI long-context tier).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "jsnum::ser_opt",
        deserialize_with = "jsnum::de_opt"
    )]
    pub long_context_threshold_tokens: Option<f64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jsnum_matches_js_number_to_string() {
        #[derive(Serialize)]
        struct W {
            #[serde(with = "jsnum")]
            v: f64,
        }
        let cases: &[(f64, &str)] = &[
            (8.378043688946248e-6, "0.000008378043688946248"),
            (0.00001, "0.00001"),
            (0.000001, "0.000001"),
            (1.5e-7, "1.5e-7"),
            (1e21, "1e+21"),
            (1e16, "10000000000000000"),
            (0.1 + 0.2, "0.30000000000000004"),
            (-0.0, "0"),
        ];
        for (v, want) in cases {
            let s = serde_json::to_string(&W { v: *v }).unwrap();
            assert_eq!(s, format!("{{\"v\":{want}}}"), "struct field {v}");
            let b = crate::util::to_vec_js(&serde_json::json!({ "v": *v })).unwrap();
            let got = String::from_utf8(b).unwrap();
            assert_eq!(got, format!("{{\"v\":{want}}}"), "value {v}");
        }
    }

    #[test]
    fn agent_ids_roundtrip() {
        for id in AgentId::ALL {
            assert_eq!(AgentId::from_id(id.as_str()), Some(*id));
            let j = serde_json::to_string(id).unwrap();
            let back: AgentId = serde_json::from_str(&j).unwrap();
            assert_eq!(back, *id);
        }
        assert_eq!(AgentId::ALL.len(), 54);
        assert_eq!(AgentId::AmazonQ.as_str(), "amazon-q");
        assert_eq!(AgentId::NineRouter.as_str(), "9router");
    }

    #[test]
    fn usage_event_json_shape() {
        let e = UsageEvent {
            id: "x".into(),
            agent: AgentId::ClaudeCode,
            input_tokens: 10.0,
            estimated_cost: Some(0.5),
            ..Default::default()
        };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["agent"], "claude-code");
        assert_eq!(v["inputTokens"].to_string(), "10");
        assert_eq!(v["model"], serde_json::Value::Null);
        assert_eq!(v["pricingStatus"], "priced");
        assert!(v.get("requestCount").is_none());
        let back: UsageEvent = serde_json::from_value(v).unwrap();
        assert_eq!(back, e);
    }

    #[test]
    fn group_row_flatten() {
        let r = GroupRow {
            key: "a".into(),
            totals: TokenTotals::default(),
            rpm: Some(3.0),
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["key"], "a");
        assert_eq!(v["totalTokens"].to_string(), "0");
        assert_eq!(v["rpm"].to_string(), "3");
        let back: GroupRow = serde_json::from_value(v).unwrap();
        assert_eq!(back, r);
    }
}
