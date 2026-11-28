//! Compact `Ts` / `EventId` must reproduce the original strings byte-for-byte.
use tokenlab::types::{EventId, Ts, UsageEvent};

#[test]
fn event_size_is_compact() {
    let sz = std::mem::size_of::<UsageEvent>();
    println!("size_of::<UsageEvent>() = {sz}");
    assert_eq!(std::mem::size_of::<Ts>(), 16);
    assert_eq!(std::mem::size_of::<EventId>(), 16);
    assert!(sz <= 152, "UsageEvent grew to {sz} bytes");
}

#[test]
fn timestamp_roundtrip_odd_strings() {
    let cases = [
        "",
        "2025-07-19T17:11:21.127Z",
        "2026-07-31T04:59:09Z",
        "1970-01-01T00:00:00.000Z",
        "1969-12-31T23:59:59.999Z",
        "0000-01-01T00:00:00.000Z",
        "9999-12-31T23:59:59.999Z",
        "2024-02-29T12:00:00.000Z",
        "2023-02-29T12:00:00.000Z",
        "2026-13-01T00:00:00.000Z",
        "2026-00-10T00:00:00.000Z",
        "2026-01-32T00:00:00.000Z",
        "2026-01-01T24:00:00.000Z",
        "2026-01-01T00:60:00.000Z",
        "2026-01-01T00:00:60.000Z",
        "2026-01-01T00:00:00.000z",
        "2026-01-01t00:00:00.000Z",
        "2026-01-01T00:00:00.000+00:00",
        "2026-01-01T00:00:00.12Z",
        "2026-01-01T00:00:00.1234Z",
        "2026-01-01 00:00:00",
        "2026-01-01",
        " 2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z ",
        "+012026-01-01T00:00:00.000Z",
        "2026-01-0１T00:00:00.000Z",
        "-2026-01-01T00:00:00.000Z",
        "not a date",
        "1700000000000",
        "Tue, 01 Jan 2026 00:00:00 GMT",
        "2026-01-01T00:00:00.000Zé",
    ];
    for c in cases {
        let t = Ts::new(c);
        assert_eq!(t.to_string(), c, "display {c:?}");
        assert_eq!(t.to_str(), c, "to_str {c:?}");
        let json = serde_json::to_string(&t).unwrap();
        assert_eq!(json, serde_json::to_string(c).unwrap(), "json {c:?}");
        let back: Ts = serde_json::from_str(&json).unwrap();
        assert_eq!(back, t);
        assert!(t == c);
        let want = tokenlab::util::js_date_parse(c);
        let got = t.js_ms();
        assert!(got == want || (got.is_nan() && want.is_nan()), "js_ms {c:?}: {got} vs {want}");
    }
}

#[test]
fn timestamp_ordering_matches_string_ordering() {
    let mut v = vec![
        "2026-07-31T04:59:09Z",
        "2026-07-31T04:59:09.000Z",
        "2026-07-31T04:59:09.500Z",
        "2026-07-31T04:59:10Z",
        "2026-07-31T04:59:08.999Z",
        "garbage",
        "",
        "2026-07-31T04:59:09.000Zx",
        "2026-07-30T23:59:59.999Z",
    ];
    let mut strs = v.clone();
    strs.sort();
    let mut ts: Vec<Ts> = v.drain(..).map(Ts::new).collect();
    ts.sort();
    let got: Vec<String> = ts.iter().map(|t| t.to_string()).collect();
    assert_eq!(got, strs);
}

#[test]
fn timestamp_sweep_roundtrip() {
    // Every 7919 s across ~ -60y..+70y, with and without millis.
    let mut s = -1_900_000_000i64;
    while s < 4_200_000_000 {
        let secs = tokenlab::util::to_iso_string((s * 1000 + 123) as f64).unwrap();
        for text in [secs.clone(), secs.replace(".123Z", "Z")] {
            if text.starts_with('-') || text.starts_with('+') {
                continue;
            }
            let t = Ts::new(&text);
            assert!(!matches!(t, Ts::Raw(_)), "should be compact: {text}");
            assert_eq!(t.to_string(), text);
            assert_eq!(t.js_ms(), tokenlab::util::js_date_parse(&text));
        }
        s += 7919;
    }
}

#[test]
fn id_roundtrip() {
    let cases = [
        "",
        "97bc3551d859ac6665dbe3d3",
        "97BC3551D859AC6665DBE3D3",
        "97bc3551d859ac6665dbe3d",
        "97bc3551d859ac6665dbe3d3a",
        "97bc3551d859ac6665dbe3dg",
        "b89bcda4d39ded19007a25d0-s7",
        "gapfill:routerlab:2026-06-18:gpt-5.5:provider:codely",
        "000000000000000000000000",
        "ffffffffffffffffffffffff",
        "é",
    ];
    for c in cases {
        let id = EventId::new(c);
        assert_eq!(id.to_string(), c);
        assert_eq!(serde_json::to_string(&id).unwrap(), serde_json::to_string(c).unwrap());
        let back: EventId = serde_json::from_str(&serde_json::to_string(&id).unwrap()).unwrap();
        assert_eq!(back, id);
        assert!(id == c);
    }
    let mut v = vec!["b", "97bc3551d859ac6665dbe3d3", "000000000000000000000001", "", "zz", "97bc3551d859ac6665dbe3d4"];
    let mut s = v.clone();
    s.sort();
    let mut ids: Vec<EventId> = v.drain(..).map(EventId::new).collect();
    ids.sort();
    assert_eq!(ids.iter().map(|i| i.to_string()).collect::<Vec<_>>(), s);
}

#[test]
fn usage_event_json_is_byte_identical() {
    let src = r#"{"id":"97bc3551d859ac6665dbe3d3","agent":"windsurf","model":"windsurf-cascade","timestamp":"2025-07-19T17:11:21.127Z","inputTokens":8851,"outputTokens":5900,"cacheReadTokens":0,"cacheWriteTokens":0,"totalTokens":14751,"estimatedCost":0.0162255,"currency":"USD","pricingStatus":"estimated","workspace":null,"sourcePath":"/x.pb","estimated":true}"#;
    let e: UsageEvent = serde_json::from_str(src).unwrap();
    assert_eq!(serde_json::to_string(&e).unwrap(), src);
    let src2 = src.replace("97bc3551d859ac6665dbe3d3", "x-s1").replace("2025-07-19T17:11:21.127Z", "2025-07-19T17:11:21Z");
    let e: UsageEvent = serde_json::from_str(&src2).unwrap();
    assert_eq!(serde_json::to_string(&e).unwrap(), src2);
}
