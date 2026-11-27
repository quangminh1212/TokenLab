//! Port of `src/pricing.ts`.
//!
//! Rate resolution order: custom rates -> OpenRouter live catalog -> bundled
//! table -> default. Cost parts are split by rate (not by token share).

use crate::config::get_config_sync;
use crate::openrouter_models::{get_open_router_fetched_at, locale_compare, lookup_open_router_rate};
use crate::types::{jsnum, ModelRate, PricingStatus, UsageEvent};
use crate::util::{js_len, js_trim, normalize_model_name, or_zero};
use indexmap::IndexMap;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// Version of the bundled rate table below.
///
/// Bump this whenever a rate changes (add / remove / edit a `BUNDLED_RATES` entry).
/// The server persists the version it last priced the scan cache with; when the
/// version differs it reprices the whole cache once, so costs derived from an
/// older table (agents with no real router cost, e.g. dsh, claude-code) do not
/// keep a stale `estimatedCost` forever.
///
/// Bump it for a parser change too, when the change rewrites which bucket the
/// tokens land in: `reprice_events` re-derives cost from the tokens already in
/// the cache and never re-runs the parser, so only the full rescan the version
/// change schedules repairs a wrong split.
pub const RATES_VERSION: f64 = 11.0;

/// Bundled offline rates (USD per 1M tokens), in the same order as the TS table
/// (insertion order matters for tie-breaking in [`resolve_model_key`]).
///
/// Prefer official vendor list prices when known (Anthropic / OpenAI / xAI docs, 2026).
/// OpenRouter rates take precedence except when a free alias has an explicit paid reference below.
///
/// Keys MUST be lowercase (except the legacy `Digigo`): `resolve_model_key`
/// lowercases before consulting this table. The LiteLLM mirror models bill a
/// cache read at the SAME rate as fresh input (`cache_read_per_1m ==
/// input_per_1m`); see the TS source for the verification notes.
pub static BUNDLED_RATES: Lazy<IndexMap<String, ModelRate>> = Lazy::new(|| {
    let entries: Vec<(&str, ModelRate)> = vec![
    // --- Anthropic (platform.claude.com/docs pricing) ---
    // Legacy Opus 4 / 4.1
    ("claude-opus-4", ModelRate { input_per_1m: 15.0, output_per_1m: 75.0, cache_read_per_1m: Some(1.5), cache_write_per_1m: Some(18.75), ..Default::default() }),
    // Current Opus 4.5–4.8 family: $5 / $25 (not legacy $15/$75)
    ("claude-opus-4.5", ModelRate { input_per_1m: 5.0, output_per_1m: 25.0, cache_read_per_1m: Some(0.5), cache_write_per_1m: Some(6.25), ..Default::default() }),
    ("claude-opus-4.6", ModelRate { input_per_1m: 5.0, output_per_1m: 25.0, cache_read_per_1m: Some(0.5), cache_write_per_1m: Some(6.25), ..Default::default() }),
    ("claude-opus-4.7", ModelRate { input_per_1m: 5.0, output_per_1m: 25.0, cache_read_per_1m: Some(0.5), cache_write_per_1m: Some(6.25), ..Default::default() }),
    ("claude-opus-4.8", ModelRate { input_per_1m: 5.0, output_per_1m: 25.0, cache_read_per_1m: Some(0.5), cache_write_per_1m: Some(6.25), ..Default::default() }),
    ("claude-opus-4-6", ModelRate { input_per_1m: 5.0, output_per_1m: 25.0, cache_read_per_1m: Some(0.5), cache_write_per_1m: Some(6.25), ..Default::default() }),
    ("claude-opus-4-6-thinking", ModelRate { input_per_1m: 5.0, output_per_1m: 25.0, cache_read_per_1m: Some(0.5), cache_write_per_1m: Some(6.25), ..Default::default() }),
    ("claude-opus-4.6-thinking", ModelRate { input_per_1m: 5.0, output_per_1m: 25.0, cache_read_per_1m: Some(0.5), cache_write_per_1m: Some(6.25), ..Default::default() }),
    ("claude-opus-4-7", ModelRate { input_per_1m: 5.0, output_per_1m: 25.0, cache_read_per_1m: Some(0.5), cache_write_per_1m: Some(6.25), ..Default::default() }),
    ("claude-opus-4-7-thinking", ModelRate { input_per_1m: 5.0, output_per_1m: 25.0, cache_read_per_1m: Some(0.5), cache_write_per_1m: Some(6.25), ..Default::default() }),
    ("claude-opus-4.7-thinking", ModelRate { input_per_1m: 5.0, output_per_1m: 25.0, cache_read_per_1m: Some(0.5), cache_write_per_1m: Some(6.25), ..Default::default() }),
    ("claude-opus-4-8", ModelRate { input_per_1m: 5.0, output_per_1m: 25.0, cache_read_per_1m: Some(0.5), cache_write_per_1m: Some(6.25), ..Default::default() }),
    ("claude-opus-4-8-medium", ModelRate { input_per_1m: 5.0, output_per_1m: 25.0, cache_read_per_1m: Some(0.5), cache_write_per_1m: Some(6.25), ..Default::default() }),
    ("claude-opus-4.8-thinking", ModelRate { input_per_1m: 5.0, output_per_1m: 25.0, cache_read_per_1m: Some(0.5), cache_write_per_1m: Some(6.25), ..Default::default() }),
    // Opus 4.8 fast mode (standard tier $10/$50)
    ("claude-opus-4.8-fast", ModelRate { input_per_1m: 10.0, output_per_1m: 50.0, cache_read_per_1m: Some(1.0), cache_write_per_1m: Some(12.5), ..Default::default() }),
    ("claude-opus-4-8-fast", ModelRate { input_per_1m: 10.0, output_per_1m: 50.0, cache_read_per_1m: Some(1.0), cache_write_per_1m: Some(12.5), ..Default::default() }),
    // Sonnet
    ("claude-sonnet-4", ModelRate { input_per_1m: 3.0, output_per_1m: 15.0, cache_read_per_1m: Some(0.3), cache_write_per_1m: Some(3.75), ..Default::default() }),
    ("claude-sonnet-4.5", ModelRate { input_per_1m: 3.0, output_per_1m: 15.0, cache_read_per_1m: Some(0.3), cache_write_per_1m: Some(3.75), ..Default::default() }),
    ("claude-sonnet-4.5-lite", ModelRate { input_per_1m: 0.3, output_per_1m: 1.5, cache_read_per_1m: Some(0.03), cache_write_per_1m: Some(0.375), ..Default::default() }),
    ("claude-sonnet-4.6", ModelRate { input_per_1m: 3.0, output_per_1m: 15.0, cache_read_per_1m: Some(0.3), cache_write_per_1m: Some(3.75), ..Default::default() }),
    ("claude-sonnet-4-6", ModelRate { input_per_1m: 3.0, output_per_1m: 15.0, cache_read_per_1m: Some(0.3), cache_write_per_1m: Some(3.75), ..Default::default() }),
    ("claude-sonnet-4-6-thinking", ModelRate { input_per_1m: 3.0, output_per_1m: 15.0, cache_read_per_1m: Some(0.3), cache_write_per_1m: Some(3.75), ..Default::default() }),
    ("claude-3-5-sonnet", ModelRate { input_per_1m: 3.0, output_per_1m: 15.0, cache_read_per_1m: Some(0.3), cache_write_per_1m: Some(3.75), ..Default::default() }),
    // Haiku
    ("claude-3-5-haiku", ModelRate { input_per_1m: 0.8, output_per_1m: 4.0, cache_read_per_1m: Some(0.08), cache_write_per_1m: Some(1.0), ..Default::default() }),
    ("claude-haiku-4", ModelRate { input_per_1m: 1.0, output_per_1m: 5.0, cache_read_per_1m: Some(0.1), cache_write_per_1m: Some(1.25), ..Default::default() }),
    ("claude-haiku-4.5", ModelRate { input_per_1m: 1.0, output_per_1m: 5.0, cache_read_per_1m: Some(0.1), cache_write_per_1m: Some(1.25), ..Default::default() }),
    // --- OpenAI (developers.openai.com/api/docs/pricing) ---
    ("gpt-5.5", ModelRate { input_per_1m: 5.0, output_per_1m: 30.0, cache_read_per_1m: Some(0.5), ..Default::default() }),
    ("gpt-5.5-high", ModelRate { input_per_1m: 5.0, output_per_1m: 30.0, cache_read_per_1m: Some(0.5), ..Default::default() }),
    ("gpt-5.5-xhigh", ModelRate { input_per_1m: 5.0, output_per_1m: 30.0, cache_read_per_1m: Some(0.5), ..Default::default() }),
    ("gpt-5.5-openai-compact", ModelRate { input_per_1m: 5.0, output_per_1m: 30.0, cache_read_per_1m: Some(0.5), ..Default::default() }),
    ("gp-gpt-5.5", ModelRate { input_per_1m: 5.0, output_per_1m: 30.0, cache_read_per_1m: Some(0.5), ..Default::default() }),
    // GPT-5.4 short-context standard
    ("gpt-5.4", ModelRate { input_per_1m: 2.5, output_per_1m: 15.0, cache_read_per_1m: Some(0.25), ..Default::default() }),
    ("gpt-5.4-openai-compact", ModelRate { input_per_1m: 2.5, output_per_1m: 15.0, cache_read_per_1m: Some(0.25), ..Default::default() }),
    ("gpt-5.4-mini", ModelRate { input_per_1m: 0.75, output_per_1m: 4.5, cache_read_per_1m: Some(0.075), ..Default::default() }),
    ("gpt-5.4-nano", ModelRate { input_per_1m: 0.2, output_per_1m: 1.25, cache_read_per_1m: Some(0.02), ..Default::default() }),
    // Codex family
    ("gpt-5.3-codex", ModelRate { input_per_1m: 1.75, output_per_1m: 14.0, cache_read_per_1m: Some(0.175), ..Default::default() }),
    ("gpt-5.3-codex-high", ModelRate { input_per_1m: 1.75, output_per_1m: 14.0, cache_read_per_1m: Some(0.175), ..Default::default() }),
    ("gpt-5.3-codex-xhigh", ModelRate { input_per_1m: 1.75, output_per_1m: 14.0, cache_read_per_1m: Some(0.175), ..Default::default() }),
    ("gpt-5.3", ModelRate { input_per_1m: 1.75, output_per_1m: 14.0, cache_read_per_1m: Some(0.175), ..Default::default() }),
    ("gpt-5.3-openai-compact", ModelRate { input_per_1m: 1.75, output_per_1m: 14.0, cache_read_per_1m: Some(0.175), ..Default::default() }),
    ("gpt-5.2", ModelRate { input_per_1m: 1.75, output_per_1m: 14.0, cache_read_per_1m: Some(0.175), ..Default::default() }),
    ("gpt-5.2-openai-compact", ModelRate { input_per_1m: 1.75, output_per_1m: 14.0, cache_read_per_1m: Some(0.175), ..Default::default() }),
    ("gpt-5.1-openai-compact", ModelRate { input_per_1m: 1.25, output_per_1m: 10.0, cache_read_per_1m: Some(0.125), ..Default::default() }),
    ("gpt-4.1", ModelRate { input_per_1m: 2.0, output_per_1m: 8.0, cache_read_per_1m: Some(0.5), ..Default::default() }),
    ("gpt-4.1-mini", ModelRate { input_per_1m: 0.4, output_per_1m: 1.6, cache_read_per_1m: Some(0.1), ..Default::default() }),
    ("gpt-4o", ModelRate { input_per_1m: 2.5, output_per_1m: 10.0, cache_read_per_1m: Some(1.25), ..Default::default() }),
    ("gpt-4o-mini", ModelRate { input_per_1m: 0.15, output_per_1m: 0.6, cache_read_per_1m: Some(0.075), ..Default::default() }),
    // o3 post price-cut (was $10/$40)
    ("o3", ModelRate { input_per_1m: 2.0, output_per_1m: 8.0, cache_read_per_1m: Some(0.5), ..Default::default() }),
    ("o3-pro", ModelRate { input_per_1m: 20.0, output_per_1m: 80.0, ..Default::default() }),
    ("o4-mini", ModelRate { input_per_1m: 1.1, output_per_1m: 4.4, cache_read_per_1m: Some(0.275), ..Default::default() }),
    // --- Google (ai.google.dev pricing, short context) ---
    // Gemini 3.7 Flash is deprecated and routes to 3.8. Standard rates through
    // 2026-12-31 are $0.75/$3.75/$0.075 per 1M input/output/cache-read tokens.
    ("gemini-3.8-flash", ModelRate { input_per_1m: 0.75, output_per_1m: 3.75, cache_read_per_1m: Some(0.075), ..Default::default() }),
    // Keep the legacy key for callers that price raw model ids without normalizing.
    ("gemini-3.7-flash", ModelRate { input_per_1m: 0.75, output_per_1m: 3.75, cache_read_per_1m: Some(0.075), ..Default::default() }),
    ("gemini-2.5-pro", ModelRate { input_per_1m: 1.25, output_per_1m: 10.0, cache_read_per_1m: Some(0.125), ..Default::default() }),
    ("gemini-2.5-flash", ModelRate { input_per_1m: 0.3, output_per_1m: 2.5, cache_read_per_1m: Some(0.03), ..Default::default() }),
    ("gemini-2.0-flash", ModelRate { input_per_1m: 0.1, output_per_1m: 0.4, cache_read_per_1m: Some(0.025), ..Default::default() }),
    // --- xAI (docs.x.ai/developers/pricing — short context <200k prompt) ---
    // Long context (≥200k) is 2× these rates; applied in priceCostParts via longContextThresholdTokens.
    ("grok-4.5", ModelRate { input_per_1m: 2.0, output_per_1m: 6.0, cache_read_per_1m: Some(0.3), long_context_threshold_tokens: Some(200000.0), ..Default::default() }),
    ("grok-4.5-build", ModelRate { input_per_1m: 2.0, output_per_1m: 6.0, cache_read_per_1m: Some(0.3), long_context_threshold_tokens: Some(200000.0), ..Default::default() }),
    ("grok-4.3", ModelRate { input_per_1m: 1.25, output_per_1m: 2.5, cache_read_per_1m: Some(0.2), long_context_threshold_tokens: Some(200000.0), ..Default::default() }),
    ("grok-4", ModelRate { input_per_1m: 3.0, output_per_1m: 15.0, cache_read_per_1m: Some(0.75), ..Default::default() }),
    ("grok-4-fast", ModelRate { input_per_1m: 0.2, output_per_1m: 0.5, cache_read_per_1m: Some(0.05), ..Default::default() }),
    ("grok-4-fast-reasoning", ModelRate { input_per_1m: 0.2, output_per_1m: 0.5, cache_read_per_1m: Some(0.05), ..Default::default() }),
    ("grok-3", ModelRate { input_per_1m: 3.0, output_per_1m: 15.0, cache_read_per_1m: Some(0.75), ..Default::default() }),
    ("grok-3-mini", ModelRate { input_per_1m: 0.3, output_per_1m: 0.5, cache_read_per_1m: Some(0.075), ..Default::default() }),
    // grok-build-0.1: $1 / $2 / cache $0.20; long ≥200k is 2×
    ("grok-build", ModelRate { input_per_1m: 1.0, output_per_1m: 2.0, cache_read_per_1m: Some(0.2), long_context_threshold_tokens: Some(200000.0), ..Default::default() }),
    ("grok-build-0.1", ModelRate { input_per_1m: 1.0, output_per_1m: 2.0, cache_read_per_1m: Some(0.2), long_context_threshold_tokens: Some(200000.0), ..Default::default() }),
    ("grok-code-fast-1", ModelRate { input_per_1m: 1.0, output_per_1m: 2.0, cache_read_per_1m: Some(0.2), ..Default::default() }),
    ("grok-code-fast", ModelRate { input_per_1m: 1.0, output_per_1m: 2.0, cache_read_per_1m: Some(0.2), ..Default::default() }),
    // --- DeepSeek (api-docs.deepseek.com) ---
    ("deepseek-v3", ModelRate { input_per_1m: 0.27, output_per_1m: 1.1, ..Default::default() }),
    ("deepseek-v3.2", ModelRate { input_per_1m: 0.28, output_per_1m: 0.42, ..Default::default() }),
    // Official: cache-miss $0.14 / out $0.28; cache-hit $0.0028
    ("deepseek-v4-flash", ModelRate { input_per_1m: 0.14, output_per_1m: 0.28, cache_read_per_1m: Some(0.0028), ..Default::default() }),
    // Official: cache-miss $0.435 / out $0.87; cache-hit $0.003625
    ("deepseek-v4-pro", ModelRate { input_per_1m: 0.435, output_per_1m: 0.87, cache_read_per_1m: Some(0.003625), ..Default::default() }),
    // Legacy aliases → v4-flash (non-thinking / thinking), same rates
    ("deepseek-chat", ModelRate { input_per_1m: 0.14, output_per_1m: 0.28, cache_read_per_1m: Some(0.0028), ..Default::default() }),
    ("deepseek-reasoner", ModelRate { input_per_1m: 0.14, output_per_1m: 0.28, cache_read_per_1m: Some(0.0028), ..Default::default() }),
    // --- GLM / Zhipu (docs.z.ai official) ---
    ("glm-5", ModelRate { input_per_1m: 1.0, output_per_1m: 3.2, cache_read_per_1m: Some(0.2), ..Default::default() }),
    ("glm-5.0", ModelRate { input_per_1m: 1.0, output_per_1m: 3.2, cache_read_per_1m: Some(0.2), ..Default::default() }),
    ("glm-5.1", ModelRate { input_per_1m: 1.4, output_per_1m: 4.4, cache_read_per_1m: Some(0.26), ..Default::default() }),
    ("glm-5.2", ModelRate { input_per_1m: 1.4, output_per_1m: 4.4, cache_read_per_1m: Some(0.26), ..Default::default() }),
    ("glm-5-2", ModelRate { input_per_1m: 1.4, output_per_1m: 4.4, cache_read_per_1m: Some(0.26), ..Default::default() }),
    ("glm-4.5", ModelRate { input_per_1m: 0.6, output_per_1m: 2.2, ..Default::default() }),
    // GLM 5.3 — same official tier as 5.1/5.2 ($1.4 / $4.4 / cache read $0.26).
    // Claude Code reaches it through the local LiteLLM alias `openclaw`.
    ("glm-5.3", ModelRate { input_per_1m: 1.4, output_per_1m: 4.4, cache_read_per_1m: Some(0.26), ..Default::default() }),
    ("glm-5-3", ModelRate { input_per_1m: 1.4, output_per_1m: 4.4, cache_read_per_1m: Some(0.26), ..Default::default() }),
    // --- MiniMax / Moonshot ---
    // MiniMax paygo (≤512k, 50% promo): $0.30 / $1.20 / cache $0.06
    ("minimax-m3", ModelRate { input_per_1m: 0.3, output_per_1m: 1.2, cache_read_per_1m: Some(0.06), ..Default::default() }),
    ("minimax-m2.7", ModelRate { input_per_1m: 0.3, output_per_1m: 1.2, cache_read_per_1m: Some(0.06), ..Default::default() }),
    ("kimi-k2.7", ModelRate { input_per_1m: 0.6, output_per_1m: 2.5, ..Default::default() }),
    ("kimi-k2.6", ModelRate { input_per_1m: 0.66, output_per_1m: 3.41, ..Default::default() }),
    ("kimi-k2.5", ModelRate { input_per_1m: 0.375, output_per_1m: 2.025, ..Default::default() }),
    // Hermes / 9router gateway aliases for Kimi K3 family
    ("kimi-k3", ModelRate { input_per_1m: 0.6, output_per_1m: 2.5, cache_read_per_1m: Some(0.06), ..Default::default() }),
    ("kimi-k3.0", ModelRate { input_per_1m: 0.6, output_per_1m: 2.5, cache_read_per_1m: Some(0.06), ..Default::default() }),
    // Qwen max family (approx OpenRouter-class rates when Hermes/9router labels them)
    ("qwen3.7-max", ModelRate { input_per_1m: 0.8, output_per_1m: 3.2, cache_read_per_1m: Some(0.08), ..Default::default() }),
    ("qwen3.8-max-preview", ModelRate { input_per_1m: 0.8, output_per_1m: 3.2, cache_read_per_1m: Some(0.08), ..Default::default() }),
    // Qwen3 Coder Next (OpenRouter qwen/qwen3-coder-next)
    ("qwen3-coder-next", ModelRate { input_per_1m: 0.18, output_per_1m: 0.9, cache_read_per_1m: Some(0.036), ..Default::default() }),
    ("qwen3-coder", ModelRate { input_per_1m: 0.22, output_per_1m: 1.8, ..Default::default() }),
    // --- StepFun / Poolside (OpenRouter list prices) ---
    // stepfun/step-3.7-flash: $0.20 / $1.15 / cache $0.04
    ("step-3.7-flash", ModelRate { input_per_1m: 0.2, output_per_1m: 1.15, cache_read_per_1m: Some(0.04), ..Default::default() }),
    ("step-3.5-flash", ModelRate { input_per_1m: 0.1, output_per_1m: 0.3, ..Default::default() }),
    // poolside/laguna-s-2.1 paid: $0.10 / $0.20 / cache $0.01 (free tier is $0 via OR)
    ("laguna-s-2.1", ModelRate { input_per_1m: 0.1, output_per_1m: 0.2, cache_read_per_1m: Some(0.01), ..Default::default() }),
    ("laguna-xs-2.1", ModelRate { input_per_1m: 0.06, output_per_1m: 0.12, cache_read_per_1m: Some(0.03), ..Default::default() }),
    // --- Agent / router house models (still approx) ---
    ("cursor-small", ModelRate { input_per_1m: 0.2, output_per_1m: 0.8, ..Default::default() }),
    ("mimo-auto", ModelRate { input_per_1m: 0.2, output_per_1m: 0.8, ..Default::default() }),
    ("swe-1.6", ModelRate { input_per_1m: 0.5, output_per_1m: 2.0, ..Default::default() }),
    ("swe-1-7", ModelRate { input_per_1m: 0.5, output_per_1m: 2.0, ..Default::default() }),
    ("adaptive", ModelRate { input_per_1m: 1.0, output_per_1m: 4.0, ..Default::default() }),
    // Paid references for the free/stealth aliases shown in the model table.
    // Big Pickle and `coding` have no disclosed paid model ID; use Qwen3 Coder
    // 480B A35B's OpenRouter list rate ($0.22 / $1.80 per 1M) as an estimate.
    ("big-pickle", ModelRate { input_per_1m: 0.22, output_per_1m: 1.8, estimated: Some(true), ..Default::default() }),
    ("coding", ModelRate { input_per_1m: 0.22, output_per_1m: 1.8, estimated: Some(true), ..Default::default() }),
    // Space Bunny is a stealth alias; MiniMax M3's paid OpenCode rate is
    // $0.30 / $1.20 per 1M, cache read $0.06. Treat the mapping as an estimate.
    ("space-bunny", ModelRate { input_per_1m: 0.3, output_per_1m: 1.2, cache_read_per_1m: Some(0.06), estimated: Some(true), ..Default::default() }),
    // Paid LongCat 2.5 Preview rate on Vercel AI Gateway.
    ("longcat-2.5-preview", ModelRate { input_per_1m: 0.3, output_per_1m: 1.2, cache_read_per_1m: Some(0.006), ..Default::default() }),
    // InclusionAI paid provider reference for Ling 3.1 Flash. Cache pricing is
    // unpublished, so the shared fallback cache estimate applies.
    ("ling-3.1-flash", ModelRate { input_per_1m: 0.3, output_per_1m: 0.9, estimated: Some(true), ..Default::default() }),
    // Current OpenRouter API rates for paid model listings; these also serve as
    // offline fallbacks when a free-suffixed route is encountered.
    ("nemotron-3-ultra-550b-a55b", ModelRate { input_per_1m: 0.6, output_per_1m: 2.4, cache_read_per_1m: Some(0.12), ..Default::default() }),
    // normalizeModelName strips `-free`, so keep the short alias as a paid key.
    ("nemotron-3-ultra", ModelRate { input_per_1m: 0.6, output_per_1m: 2.4, cache_read_per_1m: Some(0.12), ..Default::default() }),
    ("nemotron-3-ultra-free", ModelRate { input_per_1m: 0.6, output_per_1m: 2.4, cache_read_per_1m: Some(0.12), ..Default::default() }),
    ("mimo-v2.6-flash", ModelRate { input_per_1m: 0.14, output_per_1m: 0.28, cache_read_per_1m: Some(0.0028), ..Default::default() }),
    ("muse-spark-1.3-contributor", ModelRate { input_per_1m: 0.1, output_per_1m: 0.2, cache_read_per_1m: Some(0.002), ..Default::default() }),
    ("nemotron-3.5-lightning", ModelRate { input_per_1m: 0.07, output_per_1m: 0.2, cache_read_per_1m: Some(0.04), ..Default::default() }),
    ("Digigo", ModelRate { input_per_1m: 0.0, output_per_1m: 0.0, ..Default::default() }),
    ("digigo", ModelRate { input_per_1m: 0.0, output_per_1m: 0.0, ..Default::default() }),
    // --- LiteLLM mirror models seen in real usage (2026-07 .. 2026-10) ---
    // Rates back-solved from the router's own per-request cost, so the local table
    // reproduces the gateway's spend without ever copying its `cost` field. Keys
    // MUST be lowercase: `resolveModelKey` lowercases before consulting this table,
    // so a capitalised key never matches.
    //
    // IMPORTANT — how these gateways bill caching:
    // they report `prompt_tokens` as the WHOLE prompt (cache reads included) and
    //   cost = inputPer1M * promptTokens + outputPer1M * completionTokens
    // i.e. a cache read is billed at the SAME rate as fresh input, not at a
    // discount. Verified on every billed row in the live LiteLLM mirror:
    //   claude-fable-5   cost = 10*prompt + 50*out   -> 7153/7153 rows exact
    //   claude-opus-5.5  cost =  4*prompt + 20*out   ->  109/109 rows exact
    // So `cacheReadPer1M` is deliberately equal to `inputPer1M`: the `cachedTokens`
    // field tells you the hit rate, not a cheaper price. Setting it lower (or to 0)
    // would silently under-bill every cached token, which is exactly the bug this
    // table previously shipped.
    ("claude-fable-5", ModelRate { input_per_1m: 10.0, output_per_1m: 50.0, cache_read_per_1m: Some(10.0), ..Default::default() }),
    // RouterLab exports the same Claude-Fable traffic under "Claude-Fable" too.
    ("claude-fable", ModelRate { input_per_1m: 10.0, output_per_1m: 50.0, cache_read_per_1m: Some(10.0), ..Default::default() }),
    ("claude-opus-5", ModelRate { input_per_1m: 4.0, output_per_1m: 20.0, cache_read_per_1m: Some(4.0), cache_write_per_1m: Some(5.0), ..Default::default() }),
    ("claude-opus-5.5", ModelRate { input_per_1m: 4.0, output_per_1m: 20.0, cache_read_per_1m: Some(4.0), cache_write_per_1m: Some(5.0), ..Default::default() }),
    ("claude-sonnet-5.5", ModelRate { input_per_1m: 2.0, output_per_1m: 10.21, cache_read_per_1m: Some(2.0), ..Default::default() }),
    ("gpt-5.6-sol", ModelRate { input_per_1m: 5.0, output_per_1m: 30.0, cache_read_per_1m: Some(5.0), ..Default::default() }),
    ("gpt-5.6-terra", ModelRate { input_per_1m: 5.0, output_per_1m: 30.0, cache_read_per_1m: Some(5.0), ..Default::default() }),
    ("pmv-opus-4.7", ModelRate { input_per_1m: 1.6, output_per_1m: 10.24, ..Default::default() }),
    ("pmv-default", ModelRate { input_per_1m: 1.66, output_per_1m: 9.65, ..Default::default() }),
    ("openai-default", ModelRate { input_per_1m: 1.66, output_per_1m: 9.65, ..Default::default() }),
    ("kimi-k3-xlab", ModelRate { input_per_1m: 0.28, output_per_1m: 9.93, ..Default::default() }),
    ("default", ModelRate { input_per_1m: 3.0, output_per_1m: 15.0, cache_read_per_1m: Some(0.3), cache_write_per_1m: Some(3.75), ..Default::default() }),
    ];
    entries.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
});

/// `BUNDLED_RATES.default`.
pub fn default_rate() -> ModelRate {
    BUNDLED_RATES.get("default").cloned().unwrap_or_default()
}

/// Infer OpenRouter-style provider slug from a bare model id.
pub fn guess_provider(model_id: &str) -> String {
    let raw = js_trim(model_id).to_lowercase();
    if raw.is_empty() {
        return "other".to_string();
    }
    if raw.contains('/') {
        let first = raw.split('/').next().unwrap_or("");
        return if first.is_empty() { "other".to_string() } else { first.to_string() };
    }
    let sw = |p: &str| raw.starts_with(p);
    if sw("claude") {
        return "anthropic".into();
    }
    if sw("gpt") || sw("o1") || sw("o3") || sw("o4") || sw("chatgpt") || sw("gp-gpt") {
        return "openai".into();
    }
    if sw("gemini") {
        return "google".into();
    }
    if sw("grok") {
        return "x-ai".into();
    }
    if sw("deepseek") {
        return "deepseek".into();
    }
    if sw("glm") || sw("chatglm") {
        return "z-ai".into();
    }
    if sw("kimi") || raw == "vip-kimi" || sw("moonshot") {
        return "moonshotai".into();
    }
    if sw("qwen") {
        return "qwen".into();
    }
    if sw("minimax") {
        return "minimax".into();
    }
    if sw("step-") || sw("stepfun") {
        return "stepfun".into();
    }
    if sw("laguna") || sw("poolside") {
        return "poolside".into();
    }
    if sw("mistral") || sw("mixtral") || sw("codestral") {
        return "mistralai".into();
    }
    if sw("llama") || sw("meta-") {
        return "meta-llama".into();
    }
    if sw("command") || sw("cohere") {
        return "cohere".into();
    }
    if raw.contains("nemotron") {
        return "nvidia".into();
    }
    if sw("mimo") {
        return "xiaomi".into();
    }
    if raw.contains("windsurf") || sw("swe-") || raw == "cascade" {
        return "windsurf".into();
    }
    if raw.contains("cursor") {
        return "cursor".into();
    }
    if raw == "xlab" {
        return "openai".into();
    }
    "other".to_string()
}

fn alias_for(raw: &str) -> Option<&'static str> {
    Some(match raw {
        "claude-sonnet-4-20250514" => "claude-sonnet-4",
        "claude-3-5-sonnet-20241022" => "claude-3-5-sonnet",
        "claude-3-5-haiku-20241022" => "claude-3-5-haiku",
        "claude-sonnet-4-5" => "claude-sonnet-4.5",
        "claude-sonnet-4-5-lite" => "claude-sonnet-4.5-lite",
        "gpt-4.1-2025-04-14" => "gpt-4.1",
        "chatgpt-4o-latest" => "gpt-4o",
        "grok-4-latest" => "grok-4",
        "grok-code-fast-1-0825" => "grok-code-fast-1",
        "kimi-k3" => "kimi-k3",
        "qwen3.7-max" => "qwen3.7-max",
        "qwen3.8-max-preview" => "qwen3.8-max-preview",
        "qwen3-coder-next" => "qwen3-coder-next",
        "qwen-qwen3-coder-next" => "qwen3-coder-next",
        "composer" => "default",
        "deep-seek-v4-flash" => "deepseek-v4-flash",
        "deep-seek-v4-pro" => "deepseek-v4-pro",
        "deepseek-v3.2" => "deepseek-v3.2",
        "deepseek-v3-2" => "deepseek-v3.2",
        "glm-5-1" => "glm-5.1",
        "minimax-m2-7" => "minimax-m2.7",
        "step-3-7-flash" => "step-3.7-flash",
        "step-3-5-flash" => "step-3.5-flash",
        "laguna-s-2-1" => "laguna-s-2.1",
        "laguna-xs-2-1" => "laguna-xs-2.1",
        _ => return None,
    })
}

type CustomRates = IndexMap<String, ModelRate>;

fn custom_rates_of(cfg: &crate::config::XlabTokenConfig) -> &CustomRates {
    static EMPTY: Lazy<CustomRates> = Lazy::new(IndexMap::new);
    match &cfg.pricing {
        Some(p) => &p.custom_rates,
        None => &EMPTY,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RateSource {
    Custom,
    Bundled,
    Openrouter,
    Default,
}

impl RateSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            RateSource::Custom => "custom",
            RateSource::Bundled => "bundled",
            RateSource::Openrouter => "openrouter",
            RateSource::Default => "default",
        }
    }
}

/// Result of [`get_rate_for_model`].
#[derive(Debug, Clone, PartialEq)]
pub struct RateLookup {
    pub key: Option<String>,
    pub rate: ModelRate,
    pub source: RateSource,
}

/// Pricing is resolved once per model, not once per event. Dashboard period
/// aggregates can contain hundreds of thousands of rows; repeatedly scanning
/// the OpenRouter catalog for every row made 30D/All needlessly expensive.
struct LookupCache {
    /// Held (not just compared) so a freed config can never alias a new one.
    config: Option<Arc<crate::config::XlabTokenConfig>>,
    catalog_at: f64,
    map: HashMap<String, Arc<RateLookup>>,
}

static LOOKUP_CACHE: Lazy<Mutex<LookupCache>> =
    Lazy::new(|| Mutex::new(LookupCache { config: None, catalog_at: -1.0, map: HashMap::new() }));

/// Keep the cache valid for the current config view + OpenRouter catalog.
fn sync_cache_state(cache: &mut LookupCache, cfg: &Arc<crate::config::XlabTokenConfig>, catalog_at: f64) {
    // Reference equality is the cache key: the config view is stable until a
    // pricing/catalog revision replaces it.
    let same_cfg = cache.config.as_ref().map_or(false, |c| Arc::ptr_eq(c, cfg));
    if !same_cfg || cache.catalog_at != catalog_at {
        cache.map.clear();
        cache.config = Some(cfg.clone());
        cache.catalog_at = catalog_at;
    }
}

/// Free-route marker: `mintrouter-` prefix or a trailing `free` segment.
fn with_paid_reference_status(rate: ModelRate, model: Option<&str>) -> ModelRate {
    let label = js_trim(model.unwrap_or("")).to_lowercase();
    let is_free_suffix = label.ends_with("free") && {
        let pre = &label[..label.len() - 4];
        pre.is_empty() || pre.ends_with('-') || pre.ends_with('_') || pre.ends_with(':')
    };
    let is_free_alias = label.starts_with("mintrouter-") || is_free_suffix;
    if is_free_alias && rate.estimated != Some(true) {
        ModelRate { estimated: Some(true), ..rate }
    } else {
        rate
    }
}

/// `(normalizeModelName(model) || model || "").trim().toLowerCase()`
fn norm_lower(model: Option<&str>) -> String {
    let n = normalize_model_name(model).filter(|s| !s.is_empty());
    let base = match n {
        Some(n) => n,
        None => model.filter(|s| !s.is_empty()).unwrap_or("").to_string(),
    };
    js_trim(&base).to_lowercase()
}

fn resolve_model_key_with(custom: &CustomRates, model: Option<&str>) -> Option<String> {
    let model = model.filter(|m| !m.is_empty())?;
    let raw = norm_lower(Some(model));
    if raw.is_empty() {
        return None;
    }

    if custom.contains_key(&raw) {
        return Some(raw);
    }
    if let Some(a) = alias_for(&raw) {
        return Some(a.to_string());
    }
    if BUNDLED_RATES.contains_key(&raw) {
        return Some(raw);
    }

    // Longest bundled/custom key contained in model name (min length 5 to avoid "gpt"->"gpt-4.1")
    let mut keys: Vec<&str> = custom
        .keys()
        .map(|k| k.as_str())
        .chain(BUNDLED_RATES.keys().map(|k| k.as_str()).filter(|k| *k != "default"))
        .collect();
    keys.sort_by(|a, b| js_len(b).cmp(&js_len(a)));

    let raw_dashed = raw.replace('_', "-");
    for k in keys {
        let kl = k.to_lowercase();
        if raw == kl {
            return Some(k.to_string());
        }
        if js_len(&kl) >= 5 && (raw.contains(&kl) || raw_dashed.contains(&kl)) {
            return Some(k.to_string());
        }
    }

    // Family heuristics (only with enough signal)
    let has = |s: &str| raw.contains(s);
    let some = |s: &str| Some(s.to_string());
    if has("claude") && has("sonnet") && has("lite") {
        return some("claude-sonnet-4.5-lite");
    }
    if has("claude") && has("sonnet") {
        return some("claude-sonnet-4");
    }
    if has("claude") && has("opus") {
        return some("claude-opus-4");
    }
    if has("claude") && has("haiku") {
        return some("claude-3-5-haiku");
    }
    if has("gpt-5.5") {
        return some("gpt-5.5");
    }
    if has("gpt-5.4") {
        return some("gpt-5.4");
    }
    if has("gpt-5.3") && has("codex") {
        return some("gpt-5.3-codex");
    }
    if has("gpt-5.3") {
        return some("gpt-5.3");
    }
    if has("gpt-4o-mini") {
        return some("gpt-4o-mini");
    }
    if has("gpt-4o") {
        return some("gpt-4o");
    }
    if has("gpt-4.1") {
        return some("gpt-4.1");
    }
    if has("deepseek") || has("deep-seek") {
        if has("flash") {
            return some("deepseek-v4-flash");
        }
        if has("pro") {
            return some("deepseek-v4-pro");
        }
        if has("v3") {
            return some("deepseek-v3.2");
        }
        return some("deepseek-v3");
    }
    if has("gemini") && has("flash") {
        return some("gemini-2.5-flash");
    }
    if has("gemini") {
        return some("gemini-2.5-pro");
    }
    if has("grok") && has("fast") {
        return some("grok-4-fast");
    }
    // Prefer exact build / 4.5 keys before generic family fallback
    if has("grok-4.5-build") {
        return some("grok-4.5-build");
    }
    if has("grok-4.5") {
        return some("grok-4.5");
    }
    if has("grok-build") {
        return some("grok-build");
    }
    if has("grok") {
        return some("grok-4.5");
    }
    if has("glm") {
        return some("glm-5.1");
    }
    if has("minimax") {
        return some("minimax-m3");
    }
    if has("qwen3-coder-next") || has("qwen3_coder_next") {
        return some("qwen3-coder-next");
    }
    if has("step-3.7") || has("step-3-7") {
        return some("step-3.7-flash");
    }
    if has("laguna-s") {
        return some("laguna-s-2.1");
    }
    if has("laguna-xs") {
        return some("laguna-xs-2.1");
    }
    None
}

/// Resolve to a rate table key (bundled or custom).
pub fn resolve_model_key(model: Option<&str>) -> Option<String> {
    let cfg = get_config_sync();
    resolve_model_key_with(custom_rates_of(&cfg), model)
}

fn compute_rate(custom: &CustomRates, model: Option<&str>) -> RateLookup {
    let raw = norm_lower(model);
    if !raw.is_empty() {
        if let Some(r) = custom.get(&raw) {
            return RateLookup { key: Some(raw), rate: r.clone(), source: RateSource::Custom };
        }
    }
    // Custom keyed by full OpenRouter id
    if let Some(m) = model.filter(|m| !m.is_empty()) {
        let full = js_trim(m).to_lowercase();
        if !full.is_empty() {
            if let Some(r) = custom.get(&full) {
                return RateLookup { key: Some(full), rate: r.clone(), source: RateSource::Custom };
            }
        }
    }
    let key = resolve_model_key_with(custom, model);
    if let Some(k) = &key {
        if let Some(r) = custom.get(&k.to_lowercase()) {
            return RateLookup { key: key.clone(), rate: r.clone(), source: RateSource::Custom };
        }
    }

    // OpenRouter live catalog BEFORE bundled — Antigravity Gemini 3.x etc. must not
    // be forced onto gemini-2.5-* family heuristics when OR has the real rate.
    let or = lookup_open_router_rate(model)
        .or_else(|| if raw.is_empty() { None } else { lookup_open_router_rate(Some(&raw)) })
        .or_else(|| key.as_deref().and_then(|k| lookup_open_router_rate(Some(k))));
    let bundle_rate: Option<&ModelRate> = key.as_deref().and_then(|k| BUNDLED_RATES.get(k));
    let use_paid_bundle_for_free_route = match (&or, bundle_rate) {
        (Some(or), Some(b)) => {
            or.rate.input_per_1m == 0.0
                && or.rate.output_per_1m == 0.0
                && (b.input_per_1m > 0.0 || b.output_per_1m > 0.0)
        }
        _ => false,
    };
    if let Some(or) = &or {
        if let Some(r) = custom.get(&or.key.to_lowercase()) {
            return RateLookup { key: Some(or.key.clone()), rate: r.clone(), source: RateSource::Custom };
        }
        if let Some(r) = custom.get(&or.entry.slug.to_lowercase()) {
            return RateLookup { key: Some(or.entry.slug.clone()), rate: r.clone(), source: RateSource::Custom };
        }
        if !use_paid_bundle_for_free_route {
            return RateLookup {
                key: Some(or.key.clone()),
                rate: with_paid_reference_status(or.rate.clone(), model),
                source: RateSource::Openrouter,
            };
        }
    }

    if let (Some(k), Some(b)) = (&key, bundle_rate) {
        let rate = if use_paid_bundle_for_free_route {
            ModelRate { estimated: Some(true), ..b.clone() }
        } else {
            b.clone()
        };
        return RateLookup {
            key: Some(k.clone()),
            rate: with_paid_reference_status(rate, model),
            source: RateSource::Bundled,
        };
    }
    RateLookup {
        key: Some(key.unwrap_or_else(|| "default".to_string())),
        rate: default_rate(),
        source: RateSource::Default,
    }
}

/// Upper bound on distinct cached model strings (user data can hold garbage names).
const LOOKUP_CACHE_MAX: usize = 4096;

fn get_rate_arc(model: Option<&str>) -> Arc<RateLookup> {
    let cfg = get_config_sync();
    let catalog_at = get_open_router_fetched_at();
    let cache_key = match model {
        None => String::new(),
        Some(m) => js_trim(m).to_lowercase(),
    };
    {
        let mut cache = LOOKUP_CACHE.lock();
        sync_cache_state(&mut cache, &cfg, catalog_at);
        if let Some(hit) = cache.map.get(&cache_key) {
            return hit.clone();
        }
    }
    let result = Arc::new(compute_rate(custom_rates_of(&cfg), model));
    let mut cache = LOOKUP_CACHE.lock();
    sync_cache_state(&mut cache, &cfg, catalog_at);
    if cache.map.len() >= LOOKUP_CACHE_MAX {
        cache.map.clear();
    }
    cache.map.insert(cache_key, result.clone());
    result
}

pub fn get_rate_for_model(model: Option<&str>) -> RateLookup {
    (*get_rate_arc(model)).clone()
}

/// Rate-weighted cost split (`priceCostParts` result).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostParts {
    #[serde(with = "jsnum")]
    pub input_cost: f64,
    #[serde(with = "jsnum")]
    pub cache_cost: f64,
    #[serde(with = "jsnum")]
    pub output_cost: f64,
    #[serde(with = "jsnum")]
    pub table_total: f64,
}

/// Split cost by **rate** (input / cache read-write / output), not by token count share.
/// When `actual_total` is set (e.g. router-reported cost), scale parts to match while
/// keeping relative rate weights so Cache $ is not inflated like Input $.
pub fn price_cost_parts(
    model: Option<&str>,
    input_tokens: f64,
    output_tokens: f64,
    cache_read_tokens: f64,
    cache_write_tokens: f64,
    actual_total: Option<f64>,
) -> CostParts {
    let lookup = get_rate_arc(model);
    price_cost_parts_with_rate(&lookup.rate, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, actual_total)
}

fn price_cost_parts_with_rate(
    rate: &ModelRate,
    input_tokens: f64,
    output_tokens: f64,
    cache_read_tokens: f64,
    cache_write_tokens: f64,
    actual_total: Option<f64>,
) -> CostParts {
    // xAI long-context: prompt (input + cache read) >= threshold -> 2x all rates for the request
    let prompt_tokens = or_zero(input_tokens) + or_zero(cache_read_tokens);
    let long_mult = match rate.long_context_threshold_tokens {
        Some(t) if t > 0.0 && prompt_tokens >= t => 2.0,
        _ => 1.0,
    };
    let in_rate = rate.input_per_1m * long_mult;
    let out_rate = rate.output_per_1m * long_mult;
    let cache_read_rate = rate.cache_read_per_1m.unwrap_or(rate.input_per_1m * 0.1) * long_mult;
    let cache_write_rate = rate.cache_write_per_1m.unwrap_or(rate.input_per_1m * 1.25) * long_mult;
    let input_cost = (input_tokens * in_rate) / 1_000_000.0;
    let output_cost = (output_tokens * out_rate) / 1_000_000.0;
    let cache_cost = (cache_read_tokens * cache_read_rate + cache_write_tokens * cache_write_rate) / 1_000_000.0;
    let table_total = input_cost + output_cost + cache_cost;
    if let Some(actual) = actual_total {
        if actual.is_finite() && table_total > 1e-15 && (actual - table_total).abs() > 1e-12 {
            let s = actual / table_total;
            return CostParts {
                input_cost: input_cost * s,
                cache_cost: cache_cost * s,
                output_cost: output_cost * s,
                table_total,
            };
        }
    }
    CostParts { input_cost, cache_cost, output_cost, table_total }
}

/// `Pick<UsageEvent, "estimatedCost" | "pricingStatus" | "currency">`.
#[derive(Debug, Clone, PartialEq)]
pub struct PricedTokens {
    pub estimated_cost: f64,
    pub pricing_status: PricingStatus,
    pub currency: String,
}

pub fn price_tokens(
    model: Option<&str>,
    input_tokens: f64,
    output_tokens: f64,
    cache_read_tokens: f64,
    cache_write_tokens: f64,
    currency: &str,
) -> PricedTokens {
    let lookup = get_rate_arc(model);
    let rate = &lookup.rate;
    let source = lookup.source;
    let cost =
        price_cost_parts_with_rate(rate, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, None)
            .table_total;
    if input_tokens + output_tokens + cache_read_tokens + cache_write_tokens == 0.0 {
        return PricedTokens {
            estimated_cost: 0.0,
            pricing_status: PricingStatus::ZeroRate,
            currency: currency.to_string(),
        };
    }
    // Explicit free tier (both rates 0)
    if rate.input_per_1m == 0.0 && rate.output_per_1m == 0.0 {
        return PricedTokens {
            estimated_cost: 0.0,
            pricing_status: PricingStatus::ZeroRate,
            currency: currency.to_string(),
        };
    }
    PricedTokens {
        estimated_cost: cost,
        pricing_status: if rate.estimated == Some(true) {
            PricingStatus::Estimated
        } else if source == RateSource::Default {
            PricingStatus::UnknownModel
        } else {
            PricingStatus::Priced
        },
        currency: currency.to_string(),
    }
}

/// Price a partial event (`totalTokens`, cost, status and currency are
/// derived). `partial.estimated_cost` counts as a router cost only when
/// `partial.pricing_status` is `Priced` (as in TS). Use [`apply_pricing_with`]
/// to pass an explicit `routerCost`.
pub fn apply_pricing(partial: UsageEvent) -> UsageEvent {
    apply_pricing_with(partial, None)
}

/// `applyPricing({ ...partial, routerCost })`: `router_cost` (when finite) is the
/// gateway-reported cost; otherwise a priced `partial.estimated_cost` is used.
pub fn apply_pricing_with(partial: UsageEvent, router_cost: Option<f64>) -> UsageEvent {
    let total_tokens =
        partial.input_tokens + partial.output_tokens + partial.cache_read_tokens + partial.cache_write_tokens;
    // Single config read: this runs once per event across the whole dataset.
    let cfg = get_config_sync();
    let pricing_cfg = cfg.pricing.as_ref();
    let currency = pricing_cfg
        .and_then(|p| p.currency.clone())
        .filter(|c| !c.is_empty())
        .or_else(|| Some(partial.currency.clone()).filter(|c| !c.is_empty()))
        .unwrap_or_else(|| "USD".to_string());
    let prefer_router = pricing_cfg.and_then(|p| p.prefer_router_cost) != Some(false);
    let router_cost = match router_cost.filter(|c| c.is_finite()) {
        Some(c) => Some(c),
        None => match partial.estimated_cost {
            Some(c) if partial.pricing_status == PricingStatus::Priced => Some(c),
            _ => None,
        },
    };

    // A row flagged `costParityGap` was billed on a cheaper rate card than its
    // `model` label names, so the gateway's own number is the only faithful one.
    // Settle it BEFORE the generic prefer-router branch (a forced table reprice
    // would otherwise re-bill it from tokens at the wrong card). Report the
    // router figure, or 0 when there is none.
    if partial.cost_parity_gap == Some(true) {
        return UsageEvent {
            total_tokens,
            estimated_cost: Some(match router_cost {
                Some(c) if c > 0.0 => c,
                _ => 0.0,
            }),
            pricing_status: PricingStatus::ZeroRate,
            currency,
            ..partial
        };
    }

    // Prefer positive router-reported cost; never lock in router $0 when table/custom has rates
    if prefer_router {
        if let Some(c) = router_cost.filter(|c| *c > 0.0) {
            return UsageEvent {
                total_tokens,
                estimated_cost: Some(c),
                pricing_status: if partial.estimated == Some(true) {
                    PricingStatus::Estimated
                } else {
                    PricingStatus::Priced
                },
                currency,
                ..partial
            };
        }
    }

    let priced = price_tokens(
        partial.model.as_deref(),
        partial.input_tokens,
        partial.output_tokens,
        partial.cache_read_tokens,
        partial.cache_write_tokens,
        &currency,
    );
    UsageEvent {
        total_tokens,
        estimated_cost: Some(priced.estimated_cost),
        pricing_status: if partial.estimated == Some(true) { PricingStatus::Estimated } else { priced.pricing_status },
        currency: priced.currency,
        ..partial
    }
}

/// Recompute costs after rate table / custom rate changes.
/// - `force_table`: ignore sticky router costs — always use bundled + custom rates
/// - default: custom-rated models use table; others keep previous positive cost
///
/// As in TS, `machineScope` is not carried through.
pub fn reprice_events(events: &[UsageEvent], force_table: bool) -> Vec<UsageEvent> {
    let cfg = get_config_sync();
    let custom = custom_rates_of(&cfg);
    events
        .iter()
        .map(|e| {
            let norm = norm_lower(e.model.as_deref());
            let has_custom = !norm.is_empty() && custom.contains_key(&norm);
            let use_table = force_table || has_custom || e.estimated_cost.unwrap_or(0.0) <= 0.0;
            // A `costParityGap` row never had a table price: `e.estimated_cost` IS the
            // gateway figure, so it is carried through even when the table is forced.
            let router_cost = if !use_table || e.cost_parity_gap == Some(true) { e.estimated_cost } else { None };
            apply_pricing_with(
                UsageEvent {
                    id: e.id.clone(),
                    agent: e.agent,
                    model: e.model.clone(),
                    timestamp: e.timestamp.clone(),
                    input_tokens: e.input_tokens,
                    output_tokens: e.output_tokens,
                    cache_read_tokens: e.cache_read_tokens,
                    cache_write_tokens: e.cache_write_tokens,
                    workspace: e.workspace.clone(),
                    source_path: e.source_path.clone(),
                    estimated: e.estimated,
                    request_count: e.request_count,
                    cache_reported: e.cache_reported,
                    cost_parity_gap: e.cost_parity_gap,
                    estimated_cost: None,
                    ..Default::default()
                },
                router_cost,
            )
        })
        .collect()
}

/// One row of [`list_pricing_catalog`].
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CatalogRow {
    pub model: String,
    pub key: Option<String>,
    pub source: RateSource,
    #[serde(rename = "inputPer1M", with = "jsnum")]
    pub input_per_1m: f64,
    #[serde(rename = "outputPer1M", with = "jsnum")]
    pub output_per_1m: f64,
    #[serde(rename = "cacheReadPer1M", skip_serializing_if = "Option::is_none", serialize_with = "jsnum::ser_opt")]
    pub cache_read_per_1m: Option<f64>,
    #[serde(rename = "cacheWritePer1M", skip_serializing_if = "Option::is_none", serialize_with = "jsnum::ser_opt")]
    pub cache_write_per_1m: Option<f64>,
    pub estimated: bool,
}

pub fn list_pricing_catalog(models: &[String]) -> Vec<CatalogRow> {
    let cfg = get_config_sync();
    let custom = custom_rates_of(&cfg);
    let mut seen: HashSet<String> = HashSet::new();
    let mut names: Vec<String> = Vec::new();
    let mut push = |n: String| {
        if seen.insert(n.clone()) {
            names.push(n);
        }
    };
    for k in custom.keys() {
        push(k.clone());
    }
    for k in BUNDLED_RATES.keys().filter(|k| k.as_str() != "default") {
        push(k.clone());
    }
    for m in models {
        let n = normalize_model_name(Some(m)).filter(|s| !s.is_empty()).unwrap_or_else(|| m.clone());
        if !n.is_empty() {
            push(n);
        }
    }
    names.sort_by(|a, b| locale_compare(a, b));
    names
        .into_iter()
        .map(|model| {
            let RateLookup { key, rate, source } = get_rate_for_model(Some(&model));
            CatalogRow {
                model,
                key,
                source,
                input_per_1m: rate.input_per_1m,
                output_per_1m: rate.output_per_1m,
                cache_read_per_1m: rate.cache_read_per_1m,
                cache_write_per_1m: rate.cache_write_per_1m,
                estimated: rate.estimated == Some(true),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_has_default_and_order() {
        assert_eq!(BUNDLED_RATES.get("default").unwrap().input_per_1m, 3.0);
        assert_eq!(BUNDLED_RATES.keys().next().unwrap(), "claude-opus-4");
        assert_eq!(BUNDLED_RATES.len(), 126);
    }

    #[test]
    fn providers() {
        assert_eq!(guess_provider("claude-opus-4.8"), "anthropic");
        assert_eq!(guess_provider("x-ai/grok-4"), "x-ai");
        assert_eq!(guess_provider(""), "other");
        assert_eq!(guess_provider("o3-pro"), "openai");
    }

    #[test]
    fn resolve_keys() {
        assert_eq!(resolve_model_key(Some("claude-sonnet-4-5")).as_deref(), Some("claude-sonnet-4.5"));
        assert_eq!(resolve_model_key(Some("GPT-4o-mini")).as_deref(), Some("gpt-4o-mini"));
        assert_eq!(resolve_model_key(Some("totally-unknown")), None);
        assert_eq!(resolve_model_key(Some("")), None);
    }

    #[test]
    fn long_context_doubles() {
        let a = price_cost_parts(Some("grok-4.5"), 100_000.0, 1000.0, 0.0, 0.0, None);
        let b = price_cost_parts(Some("grok-4.5"), 250_000.0, 1000.0, 0.0, 0.0, None);
        assert!((a.input_cost - 0.2).abs() < 1e-12);
        assert!((b.input_cost - 1.0).abs() < 1e-12);
        assert!((b.output_cost - 0.012).abs() < 1e-12);
    }

    #[test]
    fn free_suffix_marks_estimated() {
        let r = with_paid_reference_status(ModelRate::default(), Some("foo-free"));
        assert_eq!(r.estimated, Some(true));
        let r = with_paid_reference_status(ModelRate::default(), Some("freedom"));
        assert_eq!(r.estimated, None);
    }

    #[test]
    fn apply_pricing_statuses() {
        let e = apply_pricing(UsageEvent {
            model: Some("gpt-4o".into()),
            input_tokens: 1_000_000.0,
            ..Default::default()
        });
        assert_eq!(e.total_tokens, 1_000_000.0);
        assert_eq!(e.estimated_cost, Some(2.5));
        assert_eq!(e.pricing_status, PricingStatus::Priced);
        let e = apply_pricing_with(
            UsageEvent { model: Some("gpt-4o".into()), input_tokens: 10.0, ..Default::default() },
            Some(0.5),
        );
        assert_eq!(e.estimated_cost, Some(0.5));
        let e = apply_pricing(UsageEvent { model: Some("zzz".into()), input_tokens: 10.0, ..Default::default() });
        assert_eq!(e.pricing_status, PricingStatus::UnknownModel);
        let e = apply_pricing(UsageEvent { model: Some("gpt-4o".into()), ..Default::default() });
        assert_eq!(e.pricing_status, PricingStatus::ZeroRate);
    }
}
