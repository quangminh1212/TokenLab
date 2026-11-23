//! `Date.parse` / `new Date(string)` emulation (V8 behaviour for the formats
//! that show up in agent logs) plus timezone helpers.

use super::js::{is_js_ws, js_trim};
use chrono::{Local, NaiveDate, NaiveDateTime, Offset, TimeZone};

const MS_PER_DAY: f64 = 86_400_000.0;

/// Days since 1970-01-01 for a proleptic Gregorian civil date (month 1..=12).
pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// (year, month 1..=12, day 1..=31) for a day count since the epoch.
pub fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `Date.UTC(y, mo(0-based), d, h, mi, s, ms)` for in-range components.
pub fn date_utc(y: f64, mo: f64, d: f64, h: f64, mi: f64, s: f64, ms: f64) -> f64 {
    if [y, mo, d, h, mi, s, ms].iter().any(|v| !v.is_finite()) {
        return f64::NAN;
    }
    let ym = y + (mo / 12.0).floor();
    let mn = mo.rem_euclid(12.0);
    let days = days_from_civil(ym as i64, mn as i64 + 1, 1) as f64 + d - 1.0;
    let t = days * MS_PER_DAY + h * 3_600_000.0 + mi * 60_000.0 + s * 1000.0 + ms;
    time_clip(t)
}

pub fn time_clip(t: f64) -> f64 {
    if !t.is_finite() || t.abs() > 8.64e15 {
        f64::NAN
    } else {
        t.trunc() + 0.0
    }
}

/// UTC components of an epoch-ms value: (year, month0, day, h, m, s, ms, weekday).
pub fn utc_parts(ms: f64) -> (i64, i64, i64, i64, i64, i64, i64, i64) {
    let days = (ms / MS_PER_DAY).floor();
    let rem = ms - days * MS_PER_DAY;
    let (y, m, d) = civil_from_days(days as i64);
    let rem = rem as i64;
    let wd = (days as i64 + 4).rem_euclid(7);
    (
        y,
        m - 1,
        d,
        rem / 3_600_000,
        (rem / 60_000) % 60,
        (rem / 1000) % 60,
        rem % 1000,
        wd,
    )
}

/// Offset (ms, east positive) of the host-local zone at UTC instant `utc_ms`.
pub fn local_offset_at_utc(utc_ms: f64) -> f64 {
    let secs = (utc_ms / 1000.0).floor() as i64;
    match Local.timestamp_opt(secs, 0).single() {
        Some(dt) => dt.offset().fix().local_minus_utc() as f64 * 1000.0,
        None => 0.0,
    }
}

/// Interpret naive wall-clock ms (as-if-UTC) in the host zone -> true UTC ms.
fn local_to_utc(naive_ms: f64) -> f64 {
    if !naive_ms.is_finite() {
        return f64::NAN;
    }
    let secs = (naive_ms / 1000.0).floor() as i64;
    let sub = naive_ms - (secs as f64) * 1000.0;
    let nd = match chrono::DateTime::from_timestamp(secs, 0) {
        Some(dt) => dt.naive_utc(),
        None => return f64::NAN,
    };
    let utc = match Local.from_local_datetime(&nd) {
        chrono::LocalResult::Single(dt) => dt.timestamp() as f64 * 1000.0,
        chrono::LocalResult::Ambiguous(a, _) => a.timestamp() as f64 * 1000.0,
        chrono::LocalResult::None => naive_ms - local_offset_at_utc(naive_ms - 3_600_000.0) - sub,
    };
    time_clip(utc + sub)
}

/// Host-local broken-down time of an epoch instant (month0).
pub fn local_parts(ms: f64) -> (i64, i64, i64, i64, i64, i64, i64) {
    let off = local_offset_at_utc(ms);
    let (y, mo, d, h, mi, s, msv, _) = utc_parts(ms + off);
    (y, mo, d, h, mi, s, msv)
}

/// `d.setHours(0,0,0,0)` in the host zone.
pub fn local_start_of_day(ms: f64) -> f64 {
    let (y, mo, d, ..) = local_parts(ms);
    local_to_utc(date_utc(y as f64, mo as f64, d as f64, 0.0, 0.0, 0.0, 0.0))
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

struct Cursor<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> Cursor<'a> {
    fn peek(&self) -> Option<u8> {
        self.b.get(self.i).copied()
    }
    fn eat(&mut self, c: u8) -> bool {
        if self.peek() == Some(c) {
            self.i += 1;
            true
        } else {
            false
        }
    }
    fn digits(&mut self, n: usize) -> Option<i64> {
        if self.i + n > self.b.len() {
            return None;
        }
        let mut v = 0i64;
        for k in 0..n {
            let c = self.b[self.i + k];
            if !c.is_ascii_digit() {
                return None;
            }
            v = v * 10 + (c - b'0') as i64;
        }
        self.i += n;
        Some(v)
    }
    fn done(&self) -> bool {
        self.i >= self.b.len()
    }
}

/// ISO-8601 (+ space separator, +offset variants V8 accepts). Returns None when
/// the string is not shaped like an ISO date at all (caller falls back to the
/// legacy parser), Some(NaN) when shaped like ISO but invalid.
fn parse_iso(s: &str) -> Option<f64> {
    let mut c = Cursor { b: s.as_bytes(), i: 0 };
    let year: i64;
    if matches!(c.peek(), Some(b'+') | Some(b'-')) {
        let neg = c.peek() == Some(b'-');
        c.i += 1;
        let y = c.digits(6)?;
        if neg && y == 0 {
            return Some(f64::NAN);
        }
        year = if neg { -y } else { y };
    } else {
        year = c.digits(4)?;
    }
    let mut month = 1i64;
    let mut day = 1i64;
    let mut has_month = false;
    if c.peek() == Some(b'-') {
        c.i += 1;
        month = c.digits(2)?;
        has_month = true;
        if c.peek() == Some(b'-') {
            c.i += 1;
            day = c.digits(2)?;
        }
    }
    let _ = has_month;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return Some(f64::NAN);
    }
    let date_ms = date_utc(year as f64, (month - 1) as f64, day as f64, 0.0, 0.0, 0.0, 0.0);
    if c.done() {
        return Some(date_ms);
    }
    if !(matches!(c.peek(), Some(b'T') | Some(b't') | Some(b' '))) {
        return None;
    }
    c.i += 1;
    let h = c.digits(2)?;
    if !c.eat(b':') {
        return None;
    }
    let mi = c.digits(2)?;
    let mut sec = 0i64;
    let mut ms = 0f64;
    if c.eat(b':') {
        sec = c.digits(2)?;
        if c.peek() == Some(b'.') || c.peek() == Some(b',') {
            c.i += 1;
            let start = c.i;
            while matches!(c.peek(), Some(d) if d.is_ascii_digit()) {
                c.i += 1;
            }
            if c.i == start {
                return None;
            }
            let frac = &s[start..c.i];
            let first3: String = frac.chars().take(3).collect();
            let padded = format!("{:0<3}", first3);
            ms = padded.parse::<f64>().unwrap_or(0.0);
        }
    }
    // optional whitespace before zone (legacy) is tolerated
    while c.peek() == Some(b' ') {
        c.i += 1;
    }
    let mut offset_ms: Option<f64> = None;
    match c.peek() {
        Some(b'Z') | Some(b'z') => {
            c.i += 1;
            offset_ms = Some(0.0);
        }
        Some(sign @ (b'+' | b'-')) => {
            c.i += 1;
            let oh = c.digits(2)?;
            c.eat(b':');
            let om = if c.done() { 0 } else { c.digits(2)? };
            let total = (oh * 60 + om) as f64 * 60_000.0;
            offset_ms = Some(if sign == b'-' { -total } else { total });
        }
        _ => {}
    }
    if !c.done() {
        // trailing "UTC"/"GMT" suffixes etc: let the legacy parser decide
        return None;
    }
    if h > 24 || mi > 59 || sec > 59 || (h == 24 && (mi != 0 || sec != 0 || ms != 0.0)) {
        return Some(f64::NAN);
    }
    let naive = date_ms + h as f64 * 3_600_000.0 + mi as f64 * 60_000.0 + sec as f64 * 1000.0 + ms;
    Some(match offset_ms {
        Some(o) => time_clip(naive - o),
        None => local_to_utc(naive),
    })
}

fn month_from_name(w: &str) -> Option<i64> {
    const M: [&str; 12] = [
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ];
    if w.len() < 3 {
        return None;
    }
    let p = &w[..3];
    let idx = M.iter().position(|m| *m == p)?;
    Some(idx as i64 + 1)
}

fn zone_abbrev(w: &str) -> Option<f64> {
    let h = match w {
        "z" | "gmt" | "utc" | "ut" => 0.0,
        "est" => -5.0,
        "edt" => -4.0,
        "cst" => -6.0,
        "cdt" => -5.0,
        "mst" => -7.0,
        "mdt" => -6.0,
        "pst" => -8.0,
        "pdt" => -7.0,
        _ => return None,
    };
    Some(h * 3_600_000.0)
}

/// Legacy `Date.parse` fallback: weekday/month names, `M/D/YYYY`, AM/PM, zones.
fn parse_legacy(s: &str) -> f64 {
    let lower = s.to_lowercase();
    let b = lower.as_bytes();
    let mut i = 0;
    let mut nums: Vec<i64> = Vec::new();
    let mut slash_date = false;
    let mut month: Option<i64> = None;
    let mut time: Option<(i64, i64, i64, f64)> = None;
    let mut pm: Option<bool> = None;
    let mut offset: Option<f64> = None;
    let mut ymd_first = false;
    while i < b.len() {
        let c = b[i];
        if c.is_ascii_digit() {
            let st = i;
            while i < b.len() && b[i].is_ascii_digit() {
                i += 1;
            }
            let n: i64 = match lower[st..i].parse() {
                Ok(v) => v,
                Err(_) => return f64::NAN,
            };
            if i < b.len() && b[i] == b':' && time.is_none() {
                // time
                let h = n;
                i += 1;
                let st2 = i;
                while i < b.len() && b[i].is_ascii_digit() {
                    i += 1;
                }
                if st2 == i {
                    return f64::NAN;
                }
                let mi: i64 = lower[st2..i].parse().unwrap_or(0);
                let mut sec = 0;
                let mut ms = 0.0;
                if i < b.len() && b[i] == b':' {
                    i += 1;
                    let st3 = i;
                    while i < b.len() && b[i].is_ascii_digit() {
                        i += 1;
                    }
                    if st3 == i {
                        return f64::NAN;
                    }
                    sec = lower[st3..i].parse().unwrap_or(0);
                    if i < b.len() && b[i] == b'.' {
                        i += 1;
                        let st4 = i;
                        while i < b.len() && b[i].is_ascii_digit() {
                            i += 1;
                        }
                        let frac: String = lower[st4..i].chars().take(3).collect();
                        ms = format!("{:0<3}", frac).parse::<f64>().unwrap_or(0.0);
                    }
                }
                time = Some((h, mi, sec, ms));
                continue;
            }
            if i < b.len() && b[i] == b'/' {
                slash_date = true;
            }
            if nums.is_empty() && i - st >= 3 {
                ymd_first = true;
            }
            nums.push(n);
            continue;
        }
        if c.is_ascii_alphabetic() {
            let st = i;
            while i < b.len() && (b[i].is_ascii_alphabetic() || b[i] == b'.') {
                i += 1;
            }
            let w = lower[st..i].trim_end_matches('.');
            if w == "am" || w == "a.m" {
                pm = Some(false);
            } else if w == "pm" || w == "p.m" {
                pm = Some(true);
            } else if w == "t" && time.is_none() {
                // ISO-ish separator
            } else if let Some(o) = zone_abbrev(w) {
                offset = Some(o);
            } else if let Some(m) = month_from_name(w) {
                if month.is_some() {
                    return f64::NAN;
                }
                month = Some(m);
            } else if matches!(
                &w[..w.len().min(3)],
                "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun"
            ) {
                // weekday names are ignored
            } else {
                return f64::NAN;
            }
            continue;
        }
        if (c == b'+' || c == b'-') && (time.is_some() || offset.is_some() || month.is_some()) && time.is_some() {
            // numeric zone offset after the time
            let sign = if c == b'-' { -1.0 } else { 1.0 };
            i += 1;
            let st = i;
            while i < b.len() && (b[i].is_ascii_digit() || b[i] == b':') {
                i += 1;
            }
            let digits: String = lower[st..i].chars().filter(|d| d.is_ascii_digit()).collect();
            let (hh, mm) = match digits.len() {
                1 | 2 => (digits.parse::<i64>().unwrap_or(0), 0),
                3 | 4 => {
                    let split = digits.len() - 2;
                    (
                        digits[..split].parse::<i64>().unwrap_or(0),
                        digits[split..].parse::<i64>().unwrap_or(0),
                    )
                }
                _ => return f64::NAN,
            };
            offset = Some(sign * (hh * 60 + mm) as f64 * 60_000.0);
            continue;
        }
        if c == b'(' {
            // skip comments such as "(Coordinated Universal Time)"
            while i < b.len() && b[i] != b')' {
                i += 1;
            }
            i += 1;
            continue;
        }
        if c == b'-' || c == b'/' || c == b',' || c == b'.' || c == b' ' || c == b'\t' {
            i += 1;
            continue;
        }
        if is_js_ws(lower[i..].chars().next().unwrap_or(' ')) {
            i += lower[i..].chars().next().map_or(1, |c| c.len_utf8());
            continue;
        }
        return f64::NAN;
    }
    let (year, mon, day): (i64, i64, i64);
    let fix_year = |y: i64, digits_hint_long: bool| -> i64 {
        if !digits_hint_long && (0..50).contains(&y) {
            2000 + y
        } else if !digits_hint_long && (50..100).contains(&y) {
            1900 + y
        } else {
            y
        }
    };
    if let Some(m) = month {
        match nums.len() {
            2 => {
                let (a, bn) = (nums[0], nums[1]);
                if a > 31 {
                    year = a;
                    day = bn;
                } else {
                    day = a;
                    year = fix_year(bn, bn >= 100);
                }
                mon = m;
            }
            1 => {
                day = nums[0];
                year = 2001;
                mon = m;
            }
            _ => return f64::NAN,
        }
    } else if nums.len() == 3 {
        if ymd_first {
            year = nums[0];
            mon = nums[1];
            day = nums[2];
        } else if slash_date || !slash_date {
            mon = nums[0];
            day = nums[1];
            year = fix_year(nums[2], nums[2] >= 100);
        } else {
            return f64::NAN;
        }
    } else if nums.len() == 2 && slash_date {
        mon = nums[0];
        day = nums[1];
        year = 2001;
    } else {
        return f64::NAN;
    }
    if !(1..=12).contains(&mon) || !(1..=31).contains(&day) {
        return f64::NAN;
    }
    let (mut h, mi, sec, ms) = time.unwrap_or((0, 0, 0, 0.0));
    if let Some(is_pm) = pm {
        if !(1..=12).contains(&h) {
            return f64::NAN;
        }
        if is_pm && h < 12 {
            h += 12;
        } else if !is_pm && h == 12 {
            h = 0;
        }
    }
    if h > 24 || mi > 59 || sec > 59 {
        return f64::NAN;
    }
    let naive = date_utc(year as f64, (mon - 1) as f64, day as f64, h as f64, mi as f64, sec as f64, ms);
    match offset {
        Some(o) => time_clip(naive - o),
        None => local_to_utc(naive),
    }
}

/// `Date.parse(s)`: epoch milliseconds, NaN when unparsable.
pub fn js_date_parse(s: &str) -> f64 {
    let t = js_trim(s);
    if t.is_empty() {
        return f64::NAN;
    }
    if let Some(v) = parse_iso(t) {
        return v;
    }
    parse_legacy(t)
}

/// ISO string of an epoch-ms value (`Date.prototype.toISOString`).
pub fn to_iso_string(ms: f64) -> Option<String> {
    if !ms.is_finite() || ms.abs() > 8.64e15 {
        return None;
    }
    let (y, mo, d, h, mi, s, msv, _) = utc_parts(ms);
    let year = if (0..=9999).contains(&y) {
        format!("{:04}", y)
    } else if y < 0 {
        format!("-{:06}", -y)
    } else {
        format!("+{:06}", y)
    };
    Some(format!(
        "{}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year,
        mo + 1,
        d,
        h,
        mi,
        s,
        msv
    ))
}

/// Current time, epoch ms.
pub fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

// ---------------------------------------------------------------------------
// Timezones
// ---------------------------------------------------------------------------

fn parse_tz(name: &str) -> Option<chrono_tz::Tz> {
    name.parse::<chrono_tz::Tz>().ok()
}

/// Wall-clock fields of `epoch_ms` in `tz` as-if-UTC ms, truncated to seconds.
fn wall_as_utc_ms(epoch_ms: f64, tz: chrono_tz::Tz) -> Option<f64> {
    if !epoch_ms.is_finite() {
        return None;
    }
    let secs = (epoch_ms / 1000.0).floor() as i64;
    let utc = chrono::DateTime::from_timestamp(secs, 0)?;
    let local: NaiveDateTime = utc.with_timezone(&tz).naive_local();
    Some(local.and_utc().timestamp() as f64 * 1000.0)
}

/// `zoneOffsetMs` of util.ts (offset of `timezone` at `epoch_ms`, None = unknown).
pub fn zone_offset_ms(epoch_ms: f64, timezone: &str) -> Option<f64> {
    let tz = parse_tz(timezone)?;
    let as_utc = wall_as_utc_ms(epoch_ms, tz)?;
    Some(as_utc - (epoch_ms - (epoch_ms % 1000.0)))
}

/// `timeZoneOffsetMs` of util.ts; Err when the zone is unknown.
fn time_zone_offset_ms(timezone: &str, now_ms: f64) -> Option<f64> {
    let tz = parse_tz(timezone)?;
    let as_utc = wall_as_utc_ms(now_ms, tz)?;
    Some(as_utc - now_ms)
}

/// True when `value` names an instant but not a zone (`2026-10-11T12:32:12`).
pub fn is_zoneless_timestamp(value: &str) -> bool {
    let s = js_trim(value);
    let b = s.as_bytes();
    // ^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}
    let d = |i: usize| b.get(i).map_or(false, |c| c.is_ascii_digit());
    let head_ok = b.len() >= 16
        && (0..4).all(d)
        && b[4] == b'-'
        && d(5)
        && d(6)
        && b[7] == b'-'
        && d(8)
        && d(9)
        && (b[10] == b'T' || b[10] == b' ')
        && d(11)
        && d(12)
        && b[13] == b':'
        && d(14)
        && d(15);
    if !head_ok {
        return false;
    }
    // explicit zone: trailing Z or [+-]\d{2}:?\d{2}
    let n = b.len();
    if b[n - 1] == b'Z' || b[n - 1] == b'z' {
        return false;
    }
    let has_off = |colon: bool| -> bool {
        let need = if colon { 6 } else { 5 };
        if n < need {
            return false;
        }
        let o = &b[n - need..];
        if o[0] != b'+' && o[0] != b'-' {
            return false;
        }
        if colon {
            o[1].is_ascii_digit() && o[2].is_ascii_digit() && o[3] == b':' && o[4].is_ascii_digit() && o[5].is_ascii_digit()
        } else {
            o[1..].iter().all(|c| c.is_ascii_digit())
        }
    };
    !(has_off(true) || has_off(false))
}

/// Zone-less timestamps are interpreted in `timezone` (IANA name or "local").
pub fn parse_timestamp_in_zone(value: &str, timezone: Option<&str>) -> f64 {
    let naive = js_date_parse(value);
    if !is_zoneless_timestamp(value) {
        return naive;
    }
    let zone_raw = timezone.filter(|z| !z.is_empty()).unwrap_or("local");
    let zone = js_trim(zone_raw);
    if zone.is_empty() || zone == "local" {
        return naive;
    }
    // ^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?
    let t = js_trim(value);
    let b = t.as_bytes();
    let num = |a: usize, z: usize| -> f64 { t[a..z].parse::<f64>().unwrap_or(0.0) };
    let (y, mo, d, h, mi) = (num(0, 4), num(5, 7), num(8, 10), num(11, 13), num(14, 16));
    let mut sec = 0.0;
    let mut msf = 0.0;
    if b.len() >= 19 && b[16] == b':' && b[17].is_ascii_digit() && b[18].is_ascii_digit() {
        sec = num(17, 19);
        if b.len() > 20 && b[19] == b'.' && b[20].is_ascii_digit() {
            let mut e = 20;
            while e < b.len() && e < 23 && b[e].is_ascii_digit() {
                e += 1;
            }
            msf = format!("{:0<3}", &t[20..e]).parse::<f64>().unwrap_or(0.0);
        }
    }
    let ms = date_utc(y, mo - 1.0, d, h, mi, sec, msf);
    if ms.is_nan() {
        return naive;
    }
    let first = match zone_offset_ms(ms, zone) {
        Some(o) => o,
        None => return naive,
    };
    let corrected = ms - first;
    match zone_offset_ms(corrected, zone) {
        Some(f) => ms - f,
        None => corrected,
    }
}

/// Start of calendar day in the given IANA timezone (or "local" / "UTC").
pub fn start_of_day_in_time_zone(time_zone: Option<&str>, now: f64) -> f64 {
    let raw = time_zone.map(js_trim).unwrap_or("");
    let tz = if raw.is_empty() { "local" } else { raw };
    if tz == "local" {
        return local_start_of_day(now);
    }
    if tz == "UTC" || tz == "Etc/UTC" {
        let (y, mo, d, ..) = utc_parts(now);
        return date_utc(y as f64, mo as f64, d as f64, 0.0, 0.0, 0.0, 0.0);
    }
    let offset = match time_zone_offset_ms(tz, now) {
        Some(o) => o,
        None => return local_start_of_day(now),
    };
    let (y, mo, d, ..) = utc_parts(now + offset);
    let start_as_utc = date_utc(y as f64, mo as f64, d as f64, 0.0, 0.0, 0.0, 0.0);
    let guess = start_as_utc - offset;
    let offset2 = time_zone_offset_ms(tz, guess).unwrap_or(offset);
    start_as_utc - offset2
}

/// Parse a period start. Returns epoch ms, or None.
pub fn parse_since(since: Option<&str>, time_zone: Option<&str>) -> Option<f64> {
    let since = since.filter(|s| !s.is_empty())?;
    let key = js_trim(since).to_lowercase();
    if key == "today" {
        return Some(start_of_day_in_time_zone(time_zone, now_ms()));
    }
    if key == "yesterday" {
        return Some(start_of_day_in_time_zone(time_zone, now_ms()) - 86_400_000.0);
    }
    // /^(\d+)([smhd])$/i  (no trim: matches the raw string)
    let b = since.as_bytes();
    if b.len() >= 2 {
        let unit = b[b.len() - 1].to_ascii_lowercase();
        let digits = &since[..since.len() - 1];
        if matches!(unit, b's' | b'm' | b'h' | b'd')
            && !digits.is_empty()
            && digits.bytes().all(|c| c.is_ascii_digit())
        {
            let n: f64 = digits.parse().unwrap_or(0.0);
            let ms = match unit {
                b's' => n * 1000.0,
                b'm' => n * 60_000.0,
                b'h' => n * 3_600_000.0,
                _ => n * 86_400_000.0,
            };
            return Some(now_ms() - ms);
        }
    }
    let d = js_date_parse(since);
    if d.is_nan() {
        None
    } else {
        Some(d)
    }
}

/// Silence unused import warnings for helper types in some cfgs.
#[allow(dead_code)]
fn _touch(_: NaiveDate) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_parse() {
        assert_eq!(js_date_parse("2026-10-11T12:32:12.249Z"), 1_791_721_932_249.0);
        assert_eq!(js_date_parse("2026-10-11T12:32:12+07:00"), 1_791_721_932_000.0 - 7.0 * 3_600_000.0);
        assert_eq!(js_date_parse("2026-10-11"), 1_791_676_800_000.0);
        assert!(js_date_parse("nope").is_nan());
        assert!(js_date_parse("2026-13-01").is_nan());
        assert_eq!(js_date_parse("1970-01-01T00:00:00Z"), 0.0);
    }

    #[test]
    fn legacy_parse() {
        assert_eq!(js_date_parse("Thu, 01 Jan 1970 00:00:00 GMT"), 0.0);
        assert_eq!(js_date_parse("Jan 2, 1970 00:00:00 UTC"), 86_400_000.0);
        assert_eq!(js_date_parse("1/2/1970 12:00 AM GMT"), 86_400_000.0);
    }

    #[test]
    fn zoneless() {
        assert!(is_zoneless_timestamp("2026-10-11T12:32:12"));
        assert!(is_zoneless_timestamp("2026-10-11 12:32:12.249"));
        assert!(!is_zoneless_timestamp("2026-10-11T12:32:12Z"));
        assert!(!is_zoneless_timestamp("2026-10-11T12:32:12+0700"));
        assert!(!is_zoneless_timestamp("2026-10-11"));
        let ms = parse_timestamp_in_zone("2026-10-11T12:32:12", Some("Asia/Ho_Chi_Minh"));
        assert_eq!(ms, js_date_parse("2026-10-11T12:32:12+07:00"));
    }

    #[test]
    fn day_start() {
        let now = js_date_parse("2026-10-11T20:00:00Z");
        // 03:00 next day in HCM; start of that day = 2026-10-11T17:00:00Z
        let s = start_of_day_in_time_zone(Some("Asia/Ho_Chi_Minh"), now);
        assert_eq!(s, js_date_parse("2026-10-11T17:00:00Z"));
        let u = start_of_day_in_time_zone(Some("UTC"), now);
        assert_eq!(u, js_date_parse("2026-10-11T00:00:00Z"));
    }

    #[test]
    fn civil_roundtrip() {
        for d in [-1000i64, 0, 1, 20000, 25000] {
            let (y, m, dd) = civil_from_days(d);
            assert_eq!(days_from_civil(y, m, dd), d);
        }
    }

    #[test]
    fn iso_string() {
        assert_eq!(to_iso_string(0.0).unwrap(), "1970-01-01T00:00:00.000Z");
    }
}
