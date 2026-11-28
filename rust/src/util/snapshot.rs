//! Binary boot snapshot of the parsed scan cache (`scan-cache.snap`).
//!
//! A *derived*, disposable sidecar of `scan-cache.json`: the typed event list in
//! a compact little-endian layout so boot can skip the ~4 s / 6 CPU-s JSON
//! parse. `scan-cache.json` stays the source of truth; the snapshot is only
//! trusted when its header proves it was produced for the exact file now on
//! disk (size + mtime + head/tail hash + format/parser/build version) and its
//! body CRC matches. Any mismatch, truncation or decode error yields `Err` and
//! the caller falls back to the JSON path. Nothing here panics on bad input:
//! every length is bounds-checked before use.
//!
//! Layout (all integers little-endian):
//! ```text
//! header (96 B): magic[8] "TLSNAP01" | format u32 | parser u32 | build u64
//!                | src_size u64 | src_mtime_ns u64 | src_edge u64
//!                | event_count u64 | string_count u64 | body_len u64
//!                | body_crc u32 | pad u32 | reserved[12] | header_crc u32
//! body:          string table (varint len + utf8, repeated string_count times)
//!                then event_count records
//! record:        flags u32 | agent u8 | [id 12 B | varint len + bytes]
//!                | [ts zigzag-varint delta | varint len + bytes]
//!                | tokens (varint or raw f64, per flag) x5 | [cost f64]
//!                | [request_count] | string idx varints (model, workspace,
//!                  machine_scope, currency, source_path)
//! ```

use crate::types::{AgentId, EventId, IStr, PricingStatus, Ts, UsageEvent};
use std::io::{Read, Seek, SeekFrom, Write};

/// Bump when the on-disk layout changes.
pub const FORMAT_VERSION: u32 = 1;
/// Bump when anything that makes `parse(JSON)` differ from the typed events
/// (sanitizer rules, event schema) changes. Cheap insurance on top of the
/// build hash, which already invalidates every snapshot on a new crate version.
pub const PARSER_VERSION: u32 = 1;

const MAGIC: [u8; 8] = *b"TLSNAP01";
pub const HEADER_LEN: usize = 96;
const EDGE_BYTES: u64 = 64 * 1024;
/// Smallest possible encoded record (flags + agent + ts + 5 tokens + 2 string idx).
const MIN_RECORD: usize = 4 + 1 + 5 + 2;
const TS_MIN: i64 = -62_167_219_200_000; // 0000-01-01
const TS_MAX: i64 = 253_402_300_799_999; // 9999-12-31T23:59:59.999

#[derive(Debug)]
pub enum SnapError {
    Io(std::io::Error),
    /// Header/body does not match the expected file or is malformed.
    Invalid(&'static str),
}

impl std::fmt::Display for SnapError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SnapError::Io(e) => write!(f, "io: {e}"),
            SnapError::Invalid(s) => write!(f, "{s}"),
        }
    }
}

impl From<std::io::Error> for SnapError {
    fn from(e: std::io::Error) -> Self {
        SnapError::Io(e)
    }
}

/// Identity of the source file a snapshot was derived from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SourceStamp {
    pub size: u64,
    pub mtime_ns: u64,
    /// FNV-1a over the first and last 64 KiB (+ size).
    pub edge: u64,
}

fn fnv(mut h: u64, bytes: &[u8]) -> u64 {
    for &b in bytes {
        h = (h ^ b as u64).wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// Stamp `path` (size, mtime, head/tail hash). Cheap: reads at most 128 KiB.
pub fn stamp_of(path: &std::path::Path) -> std::io::Result<SourceStamp> {
    let mut f = std::fs::File::open(path)?;
    let md = f.metadata()?;
    let size = md.len();
    let mtime_ns = md
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let mut h = fnv(0xcbf2_9ce4_8422_2325, &size.to_le_bytes());
    let head_len = size.min(EDGE_BYTES) as usize;
    let mut buf = vec![0u8; head_len];
    f.read_exact(&mut buf)?;
    h = fnv(h, &buf);
    if size > EDGE_BYTES {
        let tail_len = (size - EDGE_BYTES).min(EDGE_BYTES) as usize;
        f.seek(SeekFrom::Start(size - tail_len as u64))?;
        let mut t = vec![0u8; tail_len];
        f.read_exact(&mut t)?;
        h = fnv(h, &t);
    }
    Ok(SourceStamp { size, mtime_ns, edge: h })
}

fn build_hash() -> u64 {
    let h = fnv(0xcbf2_9ce4_8422_2325, env!("CARGO_PKG_VERSION").as_bytes());
    fnv(h, &[std::mem::size_of::<usize>() as u8, FORMAT_VERSION as u8])
}

// ---------------------------------------------------------------------------
// CRC-32 (IEEE, reflected), table built at compile time.
// ---------------------------------------------------------------------------

const CRC_TABLE: [u32; 256] = {
    let mut t = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut c = i as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
            k += 1;
        }
        t[i] = c;
        i += 1;
    }
    t
};

fn crc_update(mut crc: u32, data: &[u8]) -> u32 {
    for &b in data {
        crc = CRC_TABLE[((crc ^ b as u32) & 0xff) as usize] ^ (crc >> 8);
    }
    crc
}

pub fn crc32(data: &[u8]) -> u32 {
    !crc_update(!0, data)
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

fn put_varint(out: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        out.push((v as u8) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

fn put_zigzag(out: &mut Vec<u8>, v: i64) {
    put_varint(out, ((v << 1) ^ (v >> 63)) as u64);
}

fn put_str(out: &mut Vec<u8>, s: &str) {
    put_varint(out, s.len() as u64);
    out.extend_from_slice(s.as_bytes());
}

/// Counts bytes and CRC of everything written through it.
struct CrcWriter<W: Write> {
    inner: W,
    crc: u32,
    len: u64,
}

impl<W: Write> CrcWriter<W> {
    fn put(&mut self, data: &[u8]) -> std::io::Result<()> {
        self.crc = crc_update(self.crc, data);
        self.len += data.len() as u64;
        self.inner.write_all(data)
    }
}

/// Facts about a written body, needed to finalize the header.
#[derive(Clone, Copy, Debug)]
pub struct BodyInfo {
    pub event_count: u64,
    pub string_count: u64,
    pub body_len: u64,
    pub body_crc: u32,
}

/// Interned strings are shared allocations, so the (ptr,len) pair is a cheap,
/// always-correct key (two equal strings with different pointers just get two
/// table entries).
fn str_key(s: &IStr) -> (usize, usize) {
    let st = s.as_str();
    (st.as_ptr() as usize, st.len())
}

struct StrTable<'a> {
    map: std::collections::HashMap<(usize, usize), u32>,
    list: Vec<&'a IStr>,
}

impl<'a> StrTable<'a> {
    fn idx(&mut self, s: &'a IStr) -> u32 {
        let key = str_key(s);
        if let Some(&i) = self.map.get(&key) {
            return i;
        }
        let i = self.list.len() as u32;
        self.map.insert(key, i);
        self.list.push(s);
        i
    }
}

fn opt_bool_bits(v: Option<bool>) -> u32 {
    match v {
        None => 0,
        Some(false) => 1,
        Some(true) => 2,
    }
}

fn status_bits(s: PricingStatus) -> u32 {
    match s {
        PricingStatus::Priced => 0,
        PricingStatus::UnknownModel => 1,
        PricingStatus::ZeroRate => 2,
        PricingStatus::Estimated => 3,
    }
}

/// What `serde_json` round trip does to a number field: non-finite -> null -> 0,
/// `-0` -> `0`.
fn canon(v: f64) -> f64 {
    if v.is_finite() && v != 0.0 {
        v
    } else {
        0.0
    }
}

fn canon_opt(v: Option<f64>) -> Option<f64> {
    v.filter(|n| n.is_finite()).map(canon)
}

/// Integral and exactly representable as a varint payload.
fn as_varint(v: f64) -> Option<u64> {
    if v >= 0.0 && v < 9.007_199_254_740_992e15 && v.fract() == 0.0 {
        Some(v as u64)
    } else {
        None
    }
}

/// Encode `events` straight into `w` (header region is zero-filled; the caller
/// patches it with [`finalize_header`] once the source file stamp is known).
pub fn write_body<W: Write>(w: W, events: &[UsageEvent]) -> std::io::Result<BodyInfo> {
    let mut w = std::io::BufWriter::with_capacity(1 << 20, w);
    w.write_all(&[0u8; HEADER_LEN])?;
    let mut cw = CrcWriter { inner: w, crc: !0, len: 0 };

    // Pass 1: string table.
    let mut tab = StrTable { map: std::collections::HashMap::new(), list: Vec::new() };
    for e in events {
        if let Some(m) = &e.model {
            tab.idx(m);
        }
        if let Some(m) = &e.workspace {
            tab.idx(m);
        }
        if let Some(m) = &e.machine_scope {
            tab.idx(m);
        }
        tab.idx(&e.currency);
        tab.idx(&e.source_path);
    }
    let mut buf: Vec<u8> = Vec::with_capacity(1 << 16);
    for s in &tab.list {
        put_str(&mut buf, s.as_str());
        if buf.len() >= 1 << 15 {
            cw.put(&buf)?;
            buf.clear();
        }
    }
    cw.put(&buf)?;
    buf.clear();

    // Pass 2: records.
    let mut rec: Vec<u8> = Vec::with_capacity(128);
    let mut prev_ts: i64 = 0;
    for e in events {
        rec.clear();
        let mut flags: u32 = 0;
        let (id_kind, ts_kind) = (
            match &e.id {
                EventId::Empty => 0u32,
                EventId::Hex(_) => 1,
                EventId::Raw(_) => 2,
            },
            match &e.timestamp {
                Ts::Empty => 0u32,
                Ts::Ms(_) => 1,
                Ts::Sec(_) => 2,
                Ts::Raw(_) => 3,
            },
        );
        flags |= id_kind | (ts_kind << 2);
        let cost = canon_opt(e.estimated_cost);
        let rc = canon_opt(e.request_count);
        if e.model.is_some() {
            flags |= 1 << 4;
        }
        if e.workspace.is_some() {
            flags |= 1 << 5;
        }
        if cost.is_some() {
            flags |= 1 << 6;
        }
        if e.machine_scope.is_some() {
            flags |= 1 << 7;
        }
        if rc.is_some() {
            flags |= 1 << 8;
        }
        flags |= opt_bool_bits(e.estimated) << 9;
        flags |= opt_bool_bits(e.cache_reported) << 11;
        flags |= opt_bool_bits(e.cost_parity_gap) << 13;
        flags |= status_bits(e.pricing_status) << 15;
        let toks = [
            canon(e.input_tokens),
            canon(e.output_tokens),
            canon(e.cache_read_tokens),
            canon(e.cache_write_tokens),
            canon(e.total_tokens),
        ];
        let tok_varint: [Option<u64>; 5] = std::array::from_fn(|i| as_varint(toks[i]));
        for (i, v) in tok_varint.iter().enumerate() {
            if v.is_none() {
                flags |= 1 << (17 + i);
            }
        }
        let rc_varint = rc.and_then(as_varint);
        if rc.is_some() && rc_varint.is_none() {
            flags |= 1 << 22;
        }
        rec.extend_from_slice(&flags.to_le_bytes());
        rec.push(e.agent as u8);
        match &e.id {
            EventId::Empty => {}
            EventId::Hex(b) => rec.extend_from_slice(b),
            EventId::Raw(_) => e.id.with_str(|s| put_str(&mut rec, s)),
        }
        match &e.timestamp {
            Ts::Empty => {}
            Ts::Ms(v) | Ts::Sec(v) => {
                put_zigzag(&mut rec, v.wrapping_sub(prev_ts));
                prev_ts = *v;
            }
            Ts::Raw(_) => e.timestamp.with_str(|s| put_str(&mut rec, s)),
        }
        for i in 0..5 {
            match tok_varint[i] {
                Some(v) => put_varint(&mut rec, v),
                None => rec.extend_from_slice(&toks[i].to_bits().to_le_bytes()),
            }
        }
        if let Some(c) = cost {
            rec.extend_from_slice(&c.to_bits().to_le_bytes());
        }
        if let Some(r) = rc {
            match rc_varint {
                Some(v) => put_varint(&mut rec, v),
                None => rec.extend_from_slice(&r.to_bits().to_le_bytes()),
            }
        }
        for s in [&e.model, &e.workspace, &e.machine_scope].into_iter().flatten() {
            put_varint(&mut rec, tab.idx(s) as u64);
        }
        put_varint(&mut rec, tab.idx(&e.currency) as u64);
        put_varint(&mut rec, tab.idx(&e.source_path) as u64);
        buf.extend_from_slice(&rec);
        if buf.len() >= 1 << 16 {
            cw.put(&buf)?;
            buf.clear();
        }
    }
    cw.put(&buf)?;
    cw.inner.flush()?;
    Ok(BodyInfo {
        event_count: events.len() as u64,
        string_count: tab.list.len() as u64,
        body_len: cw.len,
        body_crc: !cw.crc,
    })
}

fn header_bytes(info: &BodyInfo, src: &SourceStamp) -> [u8; HEADER_LEN] {
    let mut h = [0u8; HEADER_LEN];
    h[0..8].copy_from_slice(&MAGIC);
    h[8..12].copy_from_slice(&FORMAT_VERSION.to_le_bytes());
    h[12..16].copy_from_slice(&PARSER_VERSION.to_le_bytes());
    h[16..24].copy_from_slice(&build_hash().to_le_bytes());
    h[24..32].copy_from_slice(&src.size.to_le_bytes());
    h[32..40].copy_from_slice(&src.mtime_ns.to_le_bytes());
    h[40..48].copy_from_slice(&src.edge.to_le_bytes());
    h[48..56].copy_from_slice(&info.event_count.to_le_bytes());
    h[56..64].copy_from_slice(&info.string_count.to_le_bytes());
    h[64..72].copy_from_slice(&info.body_len.to_le_bytes());
    h[72..76].copy_from_slice(&info.body_crc.to_le_bytes());
    let c = crc32(&h[..HEADER_LEN - 4]);
    h[HEADER_LEN - 4..].copy_from_slice(&c.to_le_bytes());
    h
}

/// Patch the real header over the zero-filled placeholder of a [`write_body`] file.
pub fn finalize_header(path: &std::path::Path, info: &BodyInfo, src: &SourceStamp) -> std::io::Result<()> {
    let mut f = std::fs::OpenOptions::new().write(true).open(path)?;
    f.seek(SeekFrom::Start(0))?;
    f.write_all(&header_bytes(info, src))?;
    f.flush()
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

struct Rd<'a> {
    b: &'a [u8],
    p: usize,
}

const TRUNC: SnapError = SnapError::Invalid("truncated");

impl<'a> Rd<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], SnapError> {
        let end = self.p.checked_add(n).ok_or(TRUNC)?;
        let s = self.b.get(self.p..end).ok_or(TRUNC)?;
        self.p = end;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8, SnapError> {
        Ok(self.take(1)?[0])
    }
    fn u32(&mut self) -> Result<u32, SnapError> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().map_err(|_| TRUNC)?))
    }
    fn f64(&mut self) -> Result<f64, SnapError> {
        Ok(f64::from_bits(u64::from_le_bytes(self.take(8)?.try_into().map_err(|_| TRUNC)?)))
    }
    fn varint(&mut self) -> Result<u64, SnapError> {
        let mut v: u64 = 0;
        for i in 0..10 {
            let b = self.u8()?;
            if i == 9 && b > 1 {
                return Err(SnapError::Invalid("varint overflow"));
            }
            v |= ((b & 0x7f) as u64) << (7 * i);
            if b & 0x80 == 0 {
                return Ok(v);
            }
        }
        Err(SnapError::Invalid("varint too long"))
    }
    fn zigzag(&mut self) -> Result<i64, SnapError> {
        let v = self.varint()?;
        Ok(((v >> 1) as i64) ^ -((v & 1) as i64))
    }
    fn string(&mut self) -> Result<&'a str, SnapError> {
        let n = usize::try_from(self.varint()?).map_err(|_| TRUNC)?;
        std::str::from_utf8(self.take(n)?).map_err(|_| SnapError::Invalid("bad utf8"))
    }
}

fn le_u64(b: &[u8]) -> u64 {
    let mut a = [0u8; 8];
    a.copy_from_slice(&b[..8]);
    u64::from_le_bytes(a)
}

fn le_u32(b: &[u8]) -> u32 {
    let mut a = [0u8; 4];
    a.copy_from_slice(&b[..4]);
    u32::from_le_bytes(a)
}

fn opt_bool(bits: u32) -> Result<Option<bool>, SnapError> {
    match bits & 3 {
        0 => Ok(None),
        1 => Ok(Some(false)),
        2 => Ok(Some(true)),
        _ => Err(SnapError::Invalid("bad bool bits")),
    }
}

/// Decode a snapshot image. `expect` is the current stamp of the source JSON;
/// any difference (or any structural problem) is an `Err`.
pub fn decode(bytes: &[u8], expect: &SourceStamp) -> Result<Vec<UsageEvent>, SnapError> {
    if bytes.len() < HEADER_LEN {
        return Err(SnapError::Invalid("short header"));
    }
    let h = &bytes[..HEADER_LEN];
    if h[0..8] != MAGIC {
        return Err(SnapError::Invalid("bad magic"));
    }
    if crc32(&h[..HEADER_LEN - 4]) != le_u32(&h[HEADER_LEN - 4..]) {
        return Err(SnapError::Invalid("header crc"));
    }
    if le_u32(&h[8..12]) != FORMAT_VERSION || le_u32(&h[12..16]) != PARSER_VERSION || le_u64(&h[16..24]) != build_hash()
    {
        return Err(SnapError::Invalid("version mismatch"));
    }
    let src = SourceStamp { size: le_u64(&h[24..32]), mtime_ns: le_u64(&h[32..40]), edge: le_u64(&h[40..48]) };
    if src != *expect {
        return Err(SnapError::Invalid("source file changed"));
    }
    let (count, nstr, body_len) = (le_u64(&h[48..56]), le_u64(&h[56..64]), le_u64(&h[64..72]));
    let body = &bytes[HEADER_LEN..];
    if body.len() as u64 != body_len {
        return Err(SnapError::Invalid("body length"));
    }
    if crc32(body) != le_u32(&h[72..76]) {
        return Err(SnapError::Invalid("body crc"));
    }
    let count = usize::try_from(count).map_err(|_| SnapError::Invalid("count"))?;
    let nstr = usize::try_from(nstr).map_err(|_| SnapError::Invalid("count"))?;
    // Never allocate more than the body could possibly describe.
    if count > body.len() / MIN_RECORD || nstr > body.len() {
        return Err(SnapError::Invalid("implausible counts"));
    }

    let mut r = Rd { b: body, p: 0 };
    let mut strs: Vec<IStr> = Vec::with_capacity(nstr);
    for _ in 0..nstr {
        strs.push(IStr::new(r.string()?));
    }
    let get = |i: u64| -> Result<IStr, SnapError> {
        strs.get(usize::try_from(i).map_err(|_| TRUNC)?)
            .cloned()
            .ok_or(SnapError::Invalid("string index"))
    };

    let mut out: Vec<UsageEvent> = Vec::with_capacity(count);
    let mut prev_ts: i64 = 0;
    for _ in 0..count {
        let flags = r.u32()?;
        let agent = *AgentId::ALL.get(r.u8()? as usize).ok_or(SnapError::Invalid("agent"))?;
        let id = match flags & 3 {
            0 => EventId::Empty,
            1 => {
                let mut a = [0u8; 12];
                a.copy_from_slice(r.take(12)?);
                EventId::Hex(a)
            }
            2 => EventId::new(r.string()?),
            _ => return Err(SnapError::Invalid("id kind")),
        };
        let timestamp = match (flags >> 2) & 3 {
            0 => Ts::Empty,
            k @ (1 | 2) => {
                let v = prev_ts.checked_add(r.zigzag()?).ok_or(SnapError::Invalid("ts overflow"))?;
                if !(TS_MIN..=TS_MAX).contains(&v) || (k == 2 && v.rem_euclid(1000) != 0) {
                    return Err(SnapError::Invalid("ts range"));
                }
                prev_ts = v;
                if k == 1 {
                    Ts::Ms(v)
                } else {
                    Ts::Sec(v)
                }
            }
            _ => Ts::new(r.string()?),
        };
        let mut toks = [0f64; 5];
        for (i, t) in toks.iter_mut().enumerate() {
            *t = if flags & (1 << (17 + i)) != 0 { r.f64()? } else { r.varint()? as f64 };
        }
        let estimated_cost = if flags & (1 << 6) != 0 { Some(r.f64()?) } else { None };
        let request_count = if flags & (1 << 8) != 0 {
            Some(if flags & (1 << 22) != 0 { r.f64()? } else { r.varint()? as f64 })
        } else {
            None
        };
        let model = if flags & (1 << 4) != 0 { Some(get(r.varint()?)?) } else { None };
        let workspace = if flags & (1 << 5) != 0 { Some(get(r.varint()?)?) } else { None };
        let machine_scope = if flags & (1 << 7) != 0 { Some(get(r.varint()?)?) } else { None };
        let currency = get(r.varint()?)?;
        let source_path = get(r.varint()?)?;
        out.push(UsageEvent {
            id,
            agent,
            model,
            timestamp,
            input_tokens: toks[0],
            output_tokens: toks[1],
            cache_read_tokens: toks[2],
            cache_write_tokens: toks[3],
            total_tokens: toks[4],
            estimated_cost,
            currency,
            pricing_status: match (flags >> 15) & 3 {
                0 => PricingStatus::Priced,
                1 => PricingStatus::UnknownModel,
                2 => PricingStatus::ZeroRate,
                _ => PricingStatus::Estimated,
            },
            workspace,
            source_path,
            estimated: opt_bool(flags >> 9)?,
            cache_reported: opt_bool(flags >> 11)?,
            machine_scope,
            request_count,
            cost_parity_gap: opt_bool(flags >> 13)?,
        });
    }
    if r.p != body.len() {
        return Err(SnapError::Invalid("trailing bytes"));
    }
    Ok(out)
}

/// Read `snap` and decode it against the current stamp of `source`.
pub fn load(snap: &std::path::Path, source: &std::path::Path) -> Result<Vec<UsageEvent>, SnapError> {
    let stamp = stamp_of(source)?;
    let bytes = std::fs::read(snap)?;
    decode(&bytes, &stamp)
}
