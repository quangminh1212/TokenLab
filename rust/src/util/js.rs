//! Helpers that reproduce JavaScript number / string semantics exactly.

/// JS `\s` character class body (WhiteSpace + LineTerminator), for regex sources.
pub const JS_WS_CLASS: &str =
    "\\t\\n\\u{000B}\\u{000C}\\r \\u{00A0}\\u{1680}\\u{2000}-\\u{200A}\\u{2028}\\u{2029}\\u{202F}\\u{205F}\\u{3000}\\u{FEFF}";

/// `true` for characters matched by JS `\s` / trimmed by `String.prototype.trim`.
pub fn is_js_ws(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n'
            | '\u{000B}'
            | '\u{000C}'
            | '\r'
            | ' '
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

/// `String.prototype.trim`.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_ws)
}

/// UTF-16 length (`String.prototype.length`).
pub fn js_len(s: &str) -> usize {
    s.chars().map(|c| c.len_utf16()).sum()
}

/// `Number(string)` (NaN for invalid input).
pub fn js_number_from_str(input: &str) -> f64 {
    let s = js_trim(input);
    if s.is_empty() {
        return 0.0;
    }
    match s {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let b = s.as_bytes();
    if b.len() > 2 && b[0] == b'0' {
        let radix = match b[1] {
            b'x' | b'X' => 16,
            b'o' | b'O' => 8,
            b'b' | b'B' => 2,
            _ => 0,
        };
        if radix != 0 {
            let mut v = 0f64;
            for &c in &b[2..] {
                match (c as char).to_digit(radix) {
                    Some(d) => v = v * radix as f64 + d as f64,
                    None => return f64::NAN,
                }
            }
            return v;
        }
    }
    // StrDecimalLiteral grammar
    let mut i = 0;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    let mut int_digits = 0;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
        int_digits += 1;
    }
    let mut frac_digits = 0;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
            frac_digits += 1;
        }
    }
    if int_digits == 0 && frac_digits == 0 {
        return f64::NAN;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let mut exp_digits = 0;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
            exp_digits += 1;
        }
        if exp_digits == 0 {
            return f64::NAN;
        }
    }
    if i != b.len() {
        return f64::NAN;
    }
    s.parse::<f64>().unwrap_or(f64::NAN)
}

/// `Number.isFinite(Number(s))` convenience.
pub fn js_numeric_string(s: &str) -> Option<f64> {
    if js_trim(s).is_empty() {
        return None;
    }
    let n = js_number_from_str(s);
    if n.is_finite() {
        Some(n)
    } else {
        None
    }
}

/// `String(number)` / `Number.prototype.toString()`.
pub fn js_num_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x == 0.0 {
        return "0".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if x < 0.0 {
        return format!("-{}", js_num_to_string(-x));
    }
    // Shortest round-trip digits via `{:e}` -> d.ddde[-]x
    let e = format!("{:e}", x);
    let (mant, exp) = e.split_once('e').unwrap();
    let exp: i32 = exp.parse().unwrap();
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exp + 1; // position of decimal point relative to digits
    if k <= n && n <= 21 {
        format!("{}{}", digits, "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{}", "0".repeat((-n) as usize), digits)
    } else {
        let sign = if n - 1 < 0 { '-' } else { '+' };
        let ex = (n - 1).abs();
        if k == 1 {
            format!("{}e{}{}", digits, sign, ex)
        } else {
            format!("{}.{}e{}{}", &digits[..1], &digits[1..], sign, ex)
        }
    }
}

/// `Math.round`: halves round toward +Infinity.
pub fn js_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let f = x.floor();
    if x - f >= 0.5 {
        f + 1.0
    } else {
        f
    }
}

/// `Number.prototype.toFixed(digits)` (ties round up in magnitude).
pub fn js_to_fixed(x: f64, digits: usize) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.abs() >= 1e21 || x.is_infinite() {
        return js_num_to_string(x);
    }
    if x < 0.0 {
        let body = js_to_fixed(-x, digits);
        // -0.00 style results keep their sign in JS only when x < 0 and rounds
        // to zero: (-0.001).toFixed(2) === "-0.00".
        return format!("-{}", body);
    }
    // Exact expansion (Rust prints exact digits for a given precision).
    let long = format!("{:.*}", digits + 40, x);
    let dot = long.find('.');
    let (int_part, frac_part) = match dot {
        Some(p) => (&long[..p], &long[p + 1..]),
        None => (long.as_str(), ""),
    };
    let kept_frac = &frac_part[..digits.min(frac_part.len())];
    let rest = &frac_part[digits.min(frac_part.len())..];
    let mut round_up = false;
    if let Some(first) = rest.chars().next() {
        if first > '5' {
            round_up = true;
        } else if first == '5' {
            // tie or above: JS rounds up either way ("pick larger n")
            round_up = true;
        }
    }
    let mut num: Vec<u8> = int_part.bytes().chain(kept_frac.bytes()).collect();
    if round_up {
        let mut i = num.len();
        loop {
            if i == 0 {
                num.insert(0, b'1');
                break;
            }
            i -= 1;
            if num[i] == b'9' {
                num[i] = b'0';
            } else {
                num[i] += 1;
                break;
            }
        }
    }
    let s = String::from_utf8(num).unwrap();
    if digits == 0 {
        s
    } else {
        let split = s.len() - digits;
        format!("{}.{}", &s[..split], &s[split..])
    }
}

/// `Math.ceil` on possibly-NaN input, `Number(x) || 0` style coercion helper.
pub fn or_zero(x: f64) -> f64 {
    if x.is_nan() {
        0.0
    } else {
        x
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn number_parse() {
        assert_eq!(js_number_from_str(" 12 "), 12.0);
        assert_eq!(js_number_from_str(""), 0.0);
        assert!(js_number_from_str("12px").is_nan());
        assert_eq!(js_number_from_str("0x10"), 16.0);
        assert_eq!(js_number_from_str("1e3"), 1000.0);
        assert_eq!(js_number_from_str(".5"), 0.5);
        assert!(js_number_from_str("inf").is_nan());
        assert!(js_number_from_str("1_0").is_nan());
    }

    #[test]
    fn number_to_string() {
        assert_eq!(js_num_to_string(1.0), "1");
        assert_eq!(js_num_to_string(1.5), "1.5");
        assert_eq!(js_num_to_string(1e21), "1e+21");
        assert_eq!(js_num_to_string(123456789012345680000.0), "123456789012345680000");
        assert_eq!(js_num_to_string(1.5e-7), "1.5e-7");
        assert_eq!(js_num_to_string(0.000001), "0.000001");
        assert_eq!(js_num_to_string(-0.25), "-0.25");
        assert_eq!(js_num_to_string(0.1 + 0.2), "0.30000000000000004");
    }

    #[test]
    fn rounding() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(-2.6), -3.0);
        assert_eq!(js_to_fixed(1.005, 2), "1.00");
        assert_eq!(js_to_fixed(2.5, 0), "3");
        assert_eq!(js_to_fixed(0.125, 2), "0.13");
        assert_eq!(js_to_fixed(0.0, 2), "0.00");
        assert_eq!(js_to_fixed(9.995, 2), "9.99");
        assert_eq!(js_to_fixed(99.999, 2), "100.00");
        assert_eq!(js_to_fixed(1234.5, 1), "1234.5");
    }
}

/// serde_json formatter that prints every `f64` exactly like
/// `JSON.stringify` (`Number::toString`): integral values without `.0`,
/// decimal form for `1e-6 <= |x| < 1e21`, `1e-7` / `1e+21` style otherwise.
/// Non-finite values become `null`.
pub struct JsFormatter;

impl serde_json::ser::Formatter for JsFormatter {
    fn write_f64<W: ?Sized + std::io::Write>(&mut self, writer: &mut W, value: f64) -> std::io::Result<()> {
        if !value.is_finite() {
            return writer.write_all(b"null");
        }
        writer.write_all(js_num_to_string(value).as_bytes())
    }

    fn write_f32<W: ?Sized + std::io::Write>(&mut self, writer: &mut W, value: f32) -> std::io::Result<()> {
        self.write_f64(writer, value as f64)
    }
}

/// `serde_json::to_vec` with JS number formatting.
pub fn to_vec_js<T: ?Sized + serde::Serialize>(value: &T) -> serde_json::Result<Vec<u8>> {
    let mut out = Vec::with_capacity(128);
    let mut ser = serde_json::Serializer::with_formatter(&mut out, JsFormatter);
    value.serialize(&mut ser)?;
    Ok(out)
}
