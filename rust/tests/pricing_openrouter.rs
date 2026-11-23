//! The OpenRouter-catalog test from `tests/pricing.test.ts`:
//! "getRateForModel prefers OpenRouter over bundled Gemini family fallback".
//!
//! The TS test skips when no catalog is on disk. Here the catalog is seeded into
//! a throwaway data dir so the assertions always run (and never touch the real
//! `%LOCALAPPDATA%\tokenlab` cache).

use tokenlab::openrouter_models::*;
use tokenlab::pricing::{get_rate_for_model, RateSource};

fn entry(id: &str, input: f64, output: f64) -> OpenRouterModelEntry {
    let (provider, slug) = id.split_once('/').unwrap();
    OpenRouterModelEntry {
        id: id.to_string(),
        name: id.to_string(),
        provider: provider.to_string(),
        slug: slug.to_string(),
        context_length: 1_000_000.0,
        modality: "text+image->text".to_string(),
        input_per_1m: input,
        output_per_1m: output,
        cache_read_per_1m: None,
        cache_write_per_1m: None,
        free: false,
        created: None,
    }
}

#[tokio::test]
async fn get_rate_for_model_prefers_openrouter_over_bundled_gemini_family_fallback() {
    let dir = tempfile::tempdir().unwrap();
    std::env::set_var("TOKENLAB_DATA_DIR", dir.path());

    replace_open_router_cache(
        1.0,
        vec![
            entry("google/gemini-3.6-flash", 0.55, 3.3),
            entry("google/gemini-3.1-flash-lite", 0.11, 0.44),
            entry("google/gemini-3.1-pro-preview", 2.2, 12.6),
        ],
    )
    .await
    .unwrap();
    load_open_router_cache_from_disk().await;

    let or_flash = lookup_open_router_rate(Some("google/gemini-3.6-flash")).expect("seeded catalog entry");

    let high = get_rate_for_model(Some("gemini-3.6-flash-high"));
    assert_eq!(high.source, RateSource::Openrouter);
    assert!(high.key.as_deref().map_or(false, |k| k.contains("gemini-3.6-flash")));
    assert_eq!(high.rate.input_per_1m, or_flash.rate.input_per_1m);
    assert_eq!(high.rate.output_per_1m, or_flash.rate.output_per_1m);

    let tiered = get_rate_for_model(Some("gemini-3.6-flash-tiered"));
    assert_eq!(tiered.source, RateSource::Openrouter);
    assert_eq!(tiered.rate.input_per_1m, or_flash.rate.input_per_1m);

    let lite = get_rate_for_model(Some("gemini-3.1-flash-lite"));
    let or_lite = lookup_open_router_rate(Some("google/gemini-3.1-flash-lite")).expect("seeded catalog entry");
    assert_eq!(lite.source, RateSource::Openrouter);
    assert_eq!(lite.rate.input_per_1m, or_lite.rate.input_per_1m);

    let pro_low = get_rate_for_model(Some("gemini-3.1-pro-low"));
    let or_pro = lookup_open_router_rate(Some("google/gemini-3.1-pro-preview")).expect("seeded catalog entry");
    assert_eq!(pro_low.source, RateSource::Openrouter);
    assert_eq!(pro_low.rate.input_per_1m, or_pro.rate.input_per_1m);
}
