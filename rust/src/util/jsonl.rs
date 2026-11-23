//! JSONL / JSON readers with stamp-keyed caching, plus `num()`.

use super::cache::{jsonl_cache_lookup, jsonl_cache_miss, jsonl_cache_store};
use super::fsx::{decode_utf8_js, read_text, stamp_file};
use super::js::{js_len, js_number_from_str, js_trim};
use super::zstd::decompress_zstd_frames;
use anyhow::Result;
use serde_json::Value;
use std::sync::Arc;

/// `/\.(?:zst|zstd)$/i`
pub fn is_zstd_path(file: &str) -> bool {
    let l = file.to_ascii_lowercase();
    l.ends_with(".zst") || l.ends_with(".zstd")
}

/// Split on `\r?\n`, trim, parse each non-empty line, skipping bad lines.
pub fn parse_jsonl(text: &str) -> Vec<Value> {
    let mut rows = Vec::new();
    for line in text.split('\n') {
        let t = js_trim(line.strip_suffix('\r').unwrap_or(line));
        if t.is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Value>(t) {
            rows.push(v);
        }
    }
    rows
}

/// Read + parse a JSONL file, reusing the previous parse for an identical stamp.
/// `Ok(None)` when the file cannot be read (or exceeds `max_bytes`).
pub async fn read_jsonl_cached(file: &str, max_bytes: Option<u64>) -> Result<Option<Arc<Vec<Value>>>> {
    let stamp = match stamp_file(file).await {
        Some(s) => s,
        None => return Ok(None),
    };
    if let Some(max) = max_bytes {
        if stamp.size > max {
            jsonl_cache_miss();
            return Ok(None);
        }
    }
    if let Some(rows) = jsonl_cache_lookup(file, &stamp) {
        return Ok(Some(rows));
    }
    jsonl_cache_miss();
    let text: String = if is_zstd_path(file) {
        let raw = tokio::fs::read(file).await?;
        let frames = tokio::task::spawn_blocking(move || decompress_zstd_frames(&raw)).await??;
        let joined: Vec<u8> = frames.into_iter().flatten().collect();
        // `Buffer.toString("utf8")` throws ERR_STRING_TOO_LONG past V8's string limit.
        decode_utf8_js(joined).ok_or_else(|| anyhow::anyhow!("string too long: {}", file))?
    } else {
        match read_text(file).await {
            Some(t) => t,
            None => return Ok(None),
        }
    };
    let text_len = js_len(&text);
    let rows = Arc::new(parse_jsonl(&text));
    jsonl_cache_store(file, stamp, rows.clone(), text_len);
    Ok(Some(rows))
}

/// Read + parse a JSON document (array, or object with a known array field).
pub async fn read_json_cached(file: &str) -> Option<Arc<Vec<Value>>> {
    let stamp = stamp_file(file).await?;
    if let Some(rows) = jsonl_cache_lookup(file, &stamp) {
        return Some(rows);
    }
    jsonl_cache_miss();
    let text = read_text(file).await?;
    let data: Value = serde_json::from_str(&text).ok()?;
    let rows: Vec<Value> = match data {
        Value::Array(a) => a,
        Value::Object(ref o) => {
            if let Some(Value::Array(a)) = o.get("messages") {
                a.clone()
            } else if let Some(Value::Array(a)) = o.get("events") {
                a.clone()
            } else if let Some(Value::Array(a)) = o.get("usage") {
                a.clone()
            } else {
                vec![data]
            }
        }
        _ => return None,
    };
    let rows = Arc::new(rows);
    jsonl_cache_store(file, stamp, rows.clone(), js_len(&text));
    Some(rows)
}

/// `num(v)`: finite number, or numeric string, else 0.
pub fn num(v: &Value) -> f64 {
    match v {
        Value::Number(n) => {
            let f = n.as_f64().unwrap_or(0.0);
            if f.is_finite() {
                f
            } else {
                0.0
            }
        }
        Value::String(s) => {
            if js_trim(s).is_empty() {
                return 0.0;
            }
            let n = js_number_from_str(s);
            if n.is_finite() {
                n
            } else {
                0.0
            }
        }
        _ => 0.0,
    }
}

/// `num(opt)` for optional lookups.
pub fn num_opt(v: Option<&Value>) -> f64 {
    v.map_or(0.0, num)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_lines_skip_bad() {
        let rows = parse_jsonl("{\"a\":1}\r\n\r\nnot json\n  {\"b\":2}  \n\u{FEFF}{\"c\":3}");
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[2], json!({"c": 3}));
    }

    #[test]
    fn num_semantics() {
        assert_eq!(num(&json!(5)), 5.0);
        assert_eq!(num(&json!("7.5")), 7.5);
        assert_eq!(num(&json!(" ")), 0.0);
        assert_eq!(num(&json!("abc")), 0.0);
        assert_eq!(num(&json!(null)), 0.0);
        assert_eq!(num(&json!(true)), 0.0);
        assert_eq!(num(&json!("Infinity")), 0.0);
    }

    #[test]
    fn zstd_ext() {
        assert!(is_zstd_path("a/b.JSONL.ZST"));
        assert!(is_zstd_path("x.zstd"));
        assert!(!is_zstd_path("x.zst.bak"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cached_read_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.jsonl");
        std::fs::write(&f, "{\"x\":1}\n{\"x\":2}\n").unwrap();
        let p = f.to_string_lossy().to_string();
        let a = read_jsonl_cached(&p, None).await.unwrap().unwrap();
        let b = read_jsonl_cached(&p, None).await.unwrap().unwrap();
        assert_eq!(a.len(), 2);
        assert!(Arc::ptr_eq(&a, &b));
        assert!(read_jsonl_cached(&p, Some(1)).await.unwrap().is_none());
        let j = dir.path().join("b.json");
        std::fs::write(&j, "{\"events\":[{\"a\":1}]}").unwrap();
        let rows = read_json_cached(&j.to_string_lossy()).await.unwrap();
        assert_eq!(rows.len(), 1);
    }
}
