//! Port of `src/types.ts`.
//!
//! JSON field names are identical to the TypeScript version (camelCase). All
//! numeric fields are `f64` (JS `number`); they serialize as integers when the
//! value is integral so on-disk files stay byte-compatible with the TS build.

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;

/// Interned, immutable, cheaply clonable string. Equal values share one
/// allocation (model names, source paths, workspaces repeat across ~1M events).
/// Serializes exactly like `String`.
#[derive(Clone, Default)]
pub struct IStr(std::sync::Arc<Box<str>>);

const SHARDS: usize = 16;
type Shard = parking_lot::Mutex<std::collections::HashSet<IStr>>;

fn interner() -> &'static [Shard; SHARDS] {
    static I: std::sync::OnceLock<[Shard; SHARDS]> = std::sync::OnceLock::new();
    I.get_or_init(|| std::array::from_fn(|_| Shard::default()))
}

fn shard_of(s: &str) -> usize {
    // FNV-1a, only used to pick a shard.
    let mut h: u32 = 0x811c_9dc5;
    for b in s.as_bytes() {
        h = (h ^ *b as u32).wrapping_mul(0x0100_0193);
    }
    (h as usize) % SHARDS
}

impl IStr {
    pub fn new(s: &str) -> IStr {
        let mut set = interner()[shard_of(s)].lock();
        if let Some(a) = set.get(s) {
            return a.clone();
        }
        let a = IStr(std::sync::Arc::new(Box::<str>::from(s)));
        set.insert(a.clone());
        a
    }

    pub fn as_str(&self) -> &str {
        self.s()
    }

    #[inline]
    fn s(&self) -> &str {
        &self.0
    }

    /// Drop interner entries no longer referenced by any `IStr`.
    pub fn purge_unused() {
        for sh in interner().iter() {
            sh.lock().retain(|a| std::sync::Arc::strong_count(&a.0) > 1);
        }
    }
}

impl std::ops::Deref for IStr {
    type Target = str;
    fn deref(&self) -> &str {
        &self.0
    }
}
impl AsRef<str> for IStr {
    fn as_ref(&self) -> &str {
        &self.0
    }
}
impl std::borrow::Borrow<str> for IStr {
    fn borrow(&self) -> &str {
        &self.0
    }
}
impl fmt::Debug for IStr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(self.s(), f)
    }
}
impl fmt::Display for IStr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.s())
    }
}
impl PartialEq for IStr {
    fn eq(&self, o: &IStr) -> bool {
        std::sync::Arc::ptr_eq(&self.0, &o.0) || self.s() == o.s()
    }
}
impl Eq for IStr {}
impl std::hash::Hash for IStr {
    fn hash<H: std::hash::Hasher>(&self, h: &mut H) {
        self.s().hash(h)
    }
}
impl PartialOrd for IStr {
    fn partial_cmp(&self, o: &IStr) -> Option<std::cmp::Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for IStr {
    fn cmp(&self, o: &IStr) -> std::cmp::Ordering {
        self.s().cmp(o.s())
    }
}
impl PartialEq<str> for IStr {
    fn eq(&self, o: &str) -> bool {
        self.s() == o
    }
}
impl PartialEq<&str> for IStr {
    fn eq(&self, o: &&str) -> bool {
        self.s() == *o
    }
}
impl PartialEq<String> for IStr {
    fn eq(&self, o: &String) -> bool {
        self.s() == o.as_str()
    }
}
impl PartialEq<std::borrow::Cow<'_, str>> for IStr {
    fn eq(&self, o: &std::borrow::Cow<'_, str>) -> bool {
        self.s() == o.as_ref()
    }
}
impl PartialEq<IStr> for str {
    fn eq(&self, o: &IStr) -> bool {
        self == o.s()
    }
}
impl PartialEq<IStr> for &str {
    fn eq(&self, o: &IStr) -> bool {
        *self == o.s()
    }
}
impl PartialEq<IStr> for String {
    fn eq(&self, o: &IStr) -> bool {
        self.as_str() == o.s()
    }
}
impl From<&str> for IStr {
    fn from(s: &str) -> IStr {
        IStr::new(s)
    }
}
impl From<&String> for IStr {
    fn from(s: &String) -> IStr {
        IStr::new(s)
    }
}
impl From<String> for IStr {
    fn from(s: String) -> IStr {
        IStr::new(&s)
    }
}
impl From<IStr> for String {
    fn from(s: IStr) -> String {
        s.s().to_string()
    }
}
impl Serialize for IStr {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.s())
    }
}
impl<'de> Deserialize<'de> for IStr {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> serde::de::Visitor<'de> for V {
            type Value = IStr;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a string")
            }
            fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<IStr, E> {
                Ok(IStr::new(v))
            }
        }
        d.deserialize_str(V)
    }
}

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

// ---------------------------------------------------------------------------
// Compact per-event scalars: timestamp and id.
//
// ~1M `UsageEvent`s live in RAM, so the two per-event `String`s (24 B inline +
// a heap block each) are stored as 16-byte enums that re-serialize
// byte-for-byte to the original string:
//   * `Ts`: canonical `YYYY-MM-DDTHH:MM:SS.mmmZ` / `...SSZ` -> epoch ms;
//     anything else (any non-canonical string) keeps the original text.
//   * `EventId`: 24 lowercase-hex chars -> 12 raw bytes; anything else keeps
//     the original text.
// ---------------------------------------------------------------------------

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Format `ms` as `YYYY-MM-DDTHH:MM:SS.mmmZ` (`with_ms`) or `...SSZ`.
fn fmt_ts(ms: i64, with_ms: bool, out: &mut [u8; 24]) -> usize {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (y, mo, d) = civil_from_days(days);
    let (h, mi, s, milli) = (rem / 3_600_000, rem / 60_000 % 60, rem / 1000 % 60, rem % 1000);
    fn put(o: &mut [u8; 24], at: usize, v: i64, n: usize) {
        let mut v = v;
        for i in (0..n).rev() {
            o[at + i] = b'0' + (v % 10) as u8;
            v /= 10;
        }
    }
    put(out, 0, y, 4);
    out[4] = b'-';
    put(out, 5, mo, 2);
    out[7] = b'-';
    put(out, 8, d, 2);
    out[10] = b'T';
    put(out, 11, h, 2);
    out[13] = b':';
    put(out, 14, mi, 2);
    out[16] = b':';
    put(out, 17, s, 2);
    if with_ms {
        out[19] = b'.';
        put(out, 20, milli, 3);
        out[23] = b'Z';
        24
    } else {
        out[19] = b'Z';
        20
    }
}

fn parse_digits(b: &[u8]) -> Option<i64> {
    let mut v = 0i64;
    for &c in b {
        if !c.is_ascii_digit() {
            return None;
        }
        v = v * 10 + (c - b'0') as i64;
    }
    Some(v)
}

/// Parse a canonical timestamp; `Some((ms, has_ms))` only when formatting the
/// result reproduces `s` exactly.
fn parse_canonical_ts(s: &str) -> Option<(i64, bool)> {
    let b = s.as_bytes();
    let with_ms = match b.len() {
        24 => true,
        20 => false,
        _ => return None,
    };
    if b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    if b[b.len() - 1] != b'Z' || (with_ms && b[19] != b'.') {
        return None;
    }
    let (y, mo, d) = (parse_digits(&b[0..4])?, parse_digits(&b[5..7])?, parse_digits(&b[8..10])?);
    let (h, mi, sec) = (parse_digits(&b[11..13])?, parse_digits(&b[14..16])?, parse_digits(&b[17..19])?);
    let milli = if with_ms { parse_digits(&b[20..23])? } else { 0 };
    let ms = (days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + sec) * 1000 + milli;
    let mut buf = [0u8; 24];
    let n = fmt_ts(ms, with_ms, &mut buf);
    if &buf[..n] == b {
        Some((ms, with_ms))
    } else {
        None
    }
}

/// Compact ISO-8601 timestamp that serializes back to its original text.
#[derive(Clone)]
pub enum Ts {
    Empty,
    /// `YYYY-MM-DDTHH:MM:SS.mmmZ`
    Ms(i64),
    /// `YYYY-MM-DDTHH:MM:SSZ` (value in ms, always a multiple of 1000)
    Sec(i64),
    Raw(Box<Box<str>>),
}

impl Default for Ts {
    fn default() -> Self {
        Ts::Empty
    }
}

impl Ts {
    pub fn new(s: &str) -> Ts {
        if s.is_empty() {
            return Ts::Empty;
        }
        match parse_canonical_ts(s) {
            Some((ms, true)) => Ts::Ms(ms),
            Some((ms, false)) => Ts::Sec(ms),
            None => Ts::Raw(Box::new(Box::from(s))),
        }
    }

    /// Run `f` on the original text without allocating.
    pub fn with_str<R>(&self, f: impl FnOnce(&str) -> R) -> R {
        let mut buf = [0u8; 24];
        match self {
            Ts::Empty => f(""),
            Ts::Ms(ms) => {
                let n = fmt_ts(*ms, true, &mut buf);
                f(std::str::from_utf8(&buf[..n]).unwrap_or(""))
            }
            Ts::Sec(ms) => {
                let n = fmt_ts(*ms, false, &mut buf);
                f(std::str::from_utf8(&buf[..n]).unwrap_or(""))
            }
            Ts::Raw(s) => f(s),
        }
    }

    pub fn to_str(&self) -> std::borrow::Cow<'_, str> {
        match self {
            Ts::Empty => std::borrow::Cow::Borrowed(""),
            Ts::Raw(s) => std::borrow::Cow::Borrowed(&***s),
            _ => std::borrow::Cow::Owned(self.with_str(|s| s.to_owned())),
        }
    }

    pub fn len(&self) -> usize {
        self.with_str(|s| s.len())
    }

    pub fn starts_with(&self, p: &str) -> bool {
        self.with_str(|s| s.starts_with(p))
    }

    pub fn ends_with(&self, p: &str) -> bool {
        self.with_str(|s| s.ends_with(p))
    }

    pub fn contains(&self, p: &str) -> bool {
        self.with_str(|s| s.contains(p))
    }

    pub fn is_empty(&self) -> bool {
        matches!(self, Ts::Empty)
    }

    /// `js_date_parse(text)` without formatting/parsing for canonical values.
    pub fn js_ms(&self) -> f64 {
        match self {
            Ts::Ms(m) | Ts::Sec(m) => *m as f64,
            _ => self.with_str(crate::util::js_date_parse),
        }
    }

    /// Epoch milliseconds when the text is a canonical timestamp.
    pub fn epoch_ms(&self) -> Option<i64> {
        match self {
            Ts::Ms(m) | Ts::Sec(m) => Some(*m),
            _ => None,
        }
    }
}

impl fmt::Debug for Ts {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.with_str(|s| fmt::Debug::fmt(s, f))
    }
}
impl fmt::Display for Ts {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.with_str(|s| f.write_str(s))
    }
}
impl PartialEq for Ts {
    fn eq(&self, o: &Ts) -> bool {
        match (self, o) {
            (Ts::Empty, Ts::Empty) => true,
            (Ts::Ms(a), Ts::Ms(b)) | (Ts::Sec(a), Ts::Sec(b)) => a == b,
            (Ts::Raw(a), Ts::Raw(b)) => a == b,
            // Different variants always carry different text (canonical forms
            // differ in length, Raw is never canonical).
            _ => false,
        }
    }
}
impl Eq for Ts {}
impl std::hash::Hash for Ts {
    fn hash<H: std::hash::Hasher>(&self, h: &mut H) {
        // Consistent with `Eq`: variants never compare equal across kinds.
        match self {
            Ts::Empty => 0u8.hash(h),
            Ts::Ms(v) => (1u8, *v).hash(h),
            Ts::Sec(v) => (2u8, *v).hash(h),
            Ts::Raw(s) => (3u8, &***s).hash(h),
        }
    }
}
impl PartialOrd for Ts {
    fn partial_cmp(&self, o: &Ts) -> Option<std::cmp::Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for Ts {
    /// Identical to comparing the original strings.
    fn cmp(&self, o: &Ts) -> std::cmp::Ordering {
        match (self, o) {
            // Fixed-width canonical forms: numeric order == lexicographic.
            (Ts::Ms(a), Ts::Ms(b)) | (Ts::Sec(a), Ts::Sec(b)) => a.cmp(b),
            _ => self.with_str(|a| o.with_str(|b| a.cmp(b))),
        }
    }
}
impl PartialEq<str> for Ts {
    fn eq(&self, o: &str) -> bool {
        self.with_str(|s| s == o)
    }
}
impl PartialEq<&str> for Ts {
    fn eq(&self, o: &&str) -> bool {
        self.with_str(|s| s == *o)
    }
}
impl PartialEq<String> for Ts {
    fn eq(&self, o: &String) -> bool {
        self.with_str(|s| s == o.as_str())
    }
}
impl From<&str> for Ts {
    fn from(s: &str) -> Ts {
        Ts::new(s)
    }
}
impl From<&String> for Ts {
    fn from(s: &String) -> Ts {
        Ts::new(s)
    }
}
impl From<String> for Ts {
    fn from(s: String) -> Ts {
        Ts::new(&s)
    }
}
impl From<&Ts> for String {
    fn from(t: &Ts) -> String {
        t.to_str().into_owned()
    }
}
impl From<Ts> for String {
    fn from(t: Ts) -> String {
        t.to_str().into_owned()
    }
}
impl Serialize for Ts {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.with_str(|t| s.serialize_str(t))
    }
}
impl<'de> Deserialize<'de> for Ts {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> serde::de::Visitor<'de> for V {
            type Value = Ts;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a timestamp string")
            }
            fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Ts, E> {
                Ok(Ts::new(v))
            }
        }
        d.deserialize_str(V)
    }
}

/// Compact event id: 24 lowercase-hex chars are stored as 12 bytes.
#[derive(Clone)]
pub enum EventId {
    Empty,
    Hex([u8; 12]),
    Raw(Box<Box<str>>),
}

impl Default for EventId {
    fn default() -> Self {
        EventId::Empty
    }
}

const HEXCH: &[u8; 16] = b"0123456789abcdef";

impl EventId {
    pub fn new(s: &str) -> EventId {
        if s.is_empty() {
            return EventId::Empty;
        }
        let b = s.as_bytes();
        if b.len() == 24 {
            fn nib(c: u8) -> Option<u8> {
                match c {
                    b'0'..=b'9' => Some(c - b'0'),
                    b'a'..=b'f' => Some(c - b'a' + 10),
                    _ => None,
                }
            }
            let mut out = [0u8; 12];
            let mut ok = true;
            for i in 0..12 {
                match (nib(b[2 * i]), nib(b[2 * i + 1])) {
                    (Some(h), Some(l)) => out[i] = h << 4 | l,
                    _ => {
                        ok = false;
                        break;
                    }
                }
            }
            if ok {
                return EventId::Hex(out);
            }
        }
        EventId::Raw(Box::new(Box::from(s)))
    }

    pub fn with_str<R>(&self, f: impl FnOnce(&str) -> R) -> R {
        match self {
            EventId::Empty => f(""),
            EventId::Hex(h) => {
                let mut buf = [0u8; 24];
                for (i, b) in h.iter().enumerate() {
                    buf[2 * i] = HEXCH[(b >> 4) as usize];
                    buf[2 * i + 1] = HEXCH[(b & 15) as usize];
                }
                f(std::str::from_utf8(&buf).unwrap_or(""))
            }
            EventId::Raw(s) => f(s),
        }
    }

    pub fn to_str(&self) -> std::borrow::Cow<'_, str> {
        match self {
            EventId::Empty => std::borrow::Cow::Borrowed(""),
            EventId::Raw(s) => std::borrow::Cow::Borrowed(&***s),
            _ => std::borrow::Cow::Owned(self.with_str(|s| s.to_owned())),
        }
    }

    pub fn len(&self) -> usize {
        self.with_str(|s| s.len())
    }

    pub fn starts_with(&self, p: &str) -> bool {
        self.with_str(|s| s.starts_with(p))
    }

    pub fn ends_with(&self, p: &str) -> bool {
        self.with_str(|s| s.ends_with(p))
    }

    pub fn contains(&self, p: &str) -> bool {
        self.with_str(|s| s.contains(p))
    }

    pub fn is_empty(&self) -> bool {
        matches!(self, EventId::Empty)
    }
}

impl fmt::Debug for EventId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.with_str(|s| fmt::Debug::fmt(s, f))
    }
}
impl fmt::Display for EventId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.with_str(|s| f.write_str(s))
    }
}
impl PartialEq for EventId {
    fn eq(&self, o: &EventId) -> bool {
        match (self, o) {
            (EventId::Empty, EventId::Empty) => true,
            (EventId::Hex(a), EventId::Hex(b)) => a == b,
            (EventId::Raw(a), EventId::Raw(b)) => a == b,
            _ => false,
        }
    }
}
impl Eq for EventId {}
impl std::hash::Hash for EventId {
    fn hash<H: std::hash::Hasher>(&self, h: &mut H) {
        match self {
            EventId::Empty => 0u8.hash(h),
            EventId::Hex(b) => (1u8, b).hash(h),
            EventId::Raw(s) => (2u8, &***s).hash(h),
        }
    }
}
impl PartialOrd for EventId {
    fn partial_cmp(&self, o: &EventId) -> Option<std::cmp::Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for EventId {
    fn cmp(&self, o: &EventId) -> std::cmp::Ordering {
        match (self, o) {
            (EventId::Hex(a), EventId::Hex(b)) => a.cmp(b),
            _ => self.with_str(|a| o.with_str(|b| a.cmp(b))),
        }
    }
}
impl PartialEq<str> for EventId {
    fn eq(&self, o: &str) -> bool {
        self.with_str(|s| s == o)
    }
}
impl PartialEq<&str> for EventId {
    fn eq(&self, o: &&str) -> bool {
        self.with_str(|s| s == *o)
    }
}
impl PartialEq<String> for EventId {
    fn eq(&self, o: &String) -> bool {
        self.with_str(|s| s == o.as_str())
    }
}
impl From<&str> for EventId {
    fn from(s: &str) -> EventId {
        EventId::new(s)
    }
}
impl From<&String> for EventId {
    fn from(s: &String) -> EventId {
        EventId::new(s)
    }
}
impl From<String> for EventId {
    fn from(s: String) -> EventId {
        EventId::new(&s)
    }
}
impl From<&EventId> for String {
    fn from(t: &EventId) -> String {
        t.to_str().into_owned()
    }
}
impl From<EventId> for String {
    fn from(t: EventId) -> String {
        t.to_str().into_owned()
    }
}
impl Serialize for EventId {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.with_str(|t| s.serialize_str(t))
    }
}
impl<'de> Deserialize<'de> for EventId {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> serde::de::Visitor<'de> for V {
            type Value = EventId;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("an id string")
            }
            fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<EventId, E> {
                Ok(EventId::new(v))
            }
        }
        d.deserialize_str(V)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageEvent {
    #[serde(default)]
    pub id: EventId,
    #[serde(default)]
    pub agent: AgentId,
    #[serde(default)]
    pub model: Option<IStr>,
    #[serde(default)]
    pub timestamp: Ts,
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
    pub currency: IStr,
    #[serde(default)]
    pub pricing_status: PricingStatus,
    #[serde(default)]
    pub workspace: Option<IStr>,
    #[serde(default)]
    pub source_path: IStr,
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
    pub machine_scope: Option<IStr>,
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
            id: EventId::Empty,
            agent: AgentId::Custom,
            model: None,
            timestamp: Ts::Empty,
            input_tokens: 0.0,
            output_tokens: 0.0,
            cache_read_tokens: 0.0,
            cache_write_tokens: 0.0,
            total_tokens: 0.0,
            estimated_cost: None,
            currency: IStr::new("USD"),
            pricing_status: PricingStatus::Priced,
            workspace: None,
            source_path: IStr::default(),
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
