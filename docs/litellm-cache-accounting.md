# LiteLLM cache-token accounting — verbatim source evidence

Source: https://github.com/BerriAI/litellm @ `main` (fetched 2026-10-09).
Local copies of the fetched files are in `scratch/litellm-src/` (provenance only; not committed).

## 1. Token semantics: `prompt_tokens` INCLUDES `cached_tokens`

`litellm/cost_calculator.py` L455-460 (`cost_per_token`):

```
## CUSTOM PRICING ##
# Normalize cache token counts across providers:
#   - Claude-Fable-compatible: usage.prompt_tokens_details.cached_tokens
#     (prompt_tokens already INCLUDES cached_tokens)
#   - Anthropic: usage.cache_read_input_tokens / cache_creation_input_tokens
#     (prompt_tokens does NOT include these — adjust before calling helper)
```

and L492-496:

```
# Anthropic reports prompt_tokens as input_tokens (excluding cache tokens).
# Adjust so the helper's "prompt_tokens includes cache tokens" invariant holds.
_normalized_prompt_tokens = float(prompt_tokens)
if _is_anthropic_style:
    _normalized_prompt_tokens += _cache_read_tokens + _cache_creation_tokens
```

`litellm/cost_calculator.py` L217-219 (`_cost_per_token_custom_pricing_helper`):

```
prompt_tokens is assumed to include both cached_tokens and cache_creation_tokens
(OpenAI-compatible convention). Anthropic-style usage where prompt_tokens excludes
cache tokens is handled at the caller (cost_per_token) before invoking this helper.
```

## 2. The canonical per-request cost formula

`litellm/litellm_core_utils/llm_cost_calc/utils.py`

`parse_prompt_tokens_details` L949-984 — **the cache hit is NOT part of `text_tokens`**:

```
cache_hit_tokens = getattr(usage.prompt_tokens_details, "cached_tokens", 0) or 0
cache_creation_tokens = (getattr(usage.prompt_tokens_details, "cache_write_tokens", 0)
                         or getattr(usage.prompt_tokens_details, "cache_creation_tokens", 0)) or 0
...
text_tokens = max((getattr(usage.prompt_tokens_details, "text_tokens", None) or 0) - cached_text_tokens, 0)
```

`generic_cost_per_token` L1384-1402 — reconstructs the details from a bare `prompt_tokens`
using exactly the "prompt_tokens includes cache" invariant:

```
total_details = text_tokens + cache_hit + audio_tokens + cache_creation + image_tokens + video_tokens
has_double_counting = (cache_hit > 0 or cache_creation > 0) and total_details > usage.prompt_tokens
if has_double_counting:
    uncached_budget = max(usage.prompt_tokens - cache_hit - cache_creation, 0)
    ...
elif text_tokens == 0 and prompt_tokens_details["image_count"] == 0:
    # Clamp to zero: inconsistent streaming usage
    prompt_tokens_details["text_tokens"] = max(
        usage.prompt_tokens - cache_hit - audio_tokens - cache_creation - image_tokens - video_tokens, 0
    )
```

`_calculate_input_cost` L1101-1113 — **the prompt cost decomposition**:

```
prompt_cost = float(prompt_tokens_details["text_tokens"]) * prompt_base_cost
prompt_cost += float(prompt_tokens_details["cache_hit_tokens"] - cache_hit_audio_tokens) * cache_read_cost
prompt_cost += float(cache_hit_audio_tokens) * (audio_cache_read_rate if ... else cache_read_cost)
```

`generic_cost_per_token` L1461-1462 — output:

```
completion_cost = float(text_tokens) * completion_base_cost
```

**Reduced to the Claude-Fable-compatible single-rate case:**

```
T = prompt_tokens                          # INCLUSIVE of cache hits
H = prompt_tokens_details.cached_tokens    # cache-hit (read) tokens
W = prompt_tokens_details.cache_write_tokens or cache_creation_tokens

prompt_cost     = (T - H - W) * input_cost_per_token
                + H          * cache_read_input_token_cost
                + W          * cache_creation_input_token_cost
completion_cost =  completion_tokens * output_cost_per_token
spend           =  prompt_cost + completion_cost
```

This is byte-identical to `generic_cost_per_token`: `text_tokens = T - H - W` (L977-984
when `prompt_tokens_details.text_tokens` is unset, and L1400-1402 when it is set), then
`text_tokens * base + H * cache_read_rate + W * cache_creation_rate`.

## 3. Rate lookup / fallbacks

`get_cost_per_unit` L817-855:

```
cache_read_input_token_cost: get_cost_per_unit(model_info, "...", None)
# returns None when the model publishes NO cache rate  → that term contributes 0.0
# (calculate_cost_component L811-814 returns 0.0 when cost_per_unit is not a float)
```

So an unpublished cache-read rate bills cache hits at **zero**, never at the input rate.
`calculate_prompt_caching_savings` L1765 uses `cache_creation_cost or prompt_base_cost`, i.e. an
unpublished cache-WRITE rate falls back to the input rate — but only for the savings ledger, not
for the spend total.

## 4. Per-request vs. aggregate: same formula, no request-scoped state

`response_cost_calculator` L2051-2054 returns the same total regardless of batch size, and
`BaseTokenUsageProcessor.combine_usage_objects` L2798 sums the usage counters before the one
`cost_per_token` call. LiteLLM therefore has **no** "requests/day" divisor: a period total is the
plain sum of its per-request costs.

## 5. What the mirror's field names mean

`litellm/litellm_core_utils/llm_cost_calc/usage_object_transformation.py` and
`litellm/proxy/spend_tracking/spend_tracking_utils.py` L749-772 map the UI/spend payload to:

```
prompt_tokens              = T  (inclusive of cache reads)
completion_tokens          = output
prompt_tokens_details.cached_tokens         -> cache_read_input_tokens
prompt_tokens_details.cache_write_tokens
  or .cache_creation_tokens                 -> cache_creation_input_tokens
```

`spend_tracking_utils.py` L762-765:

```
cached_tokens = prompt_tokens_details.get("cached_tokens")
if isinstance(cached_tokens, int) and cached_tokens > 0:
    additional_usage_values["cache_read_input_tokens"] = cached_tokens
```

The VPS UI export writes those two derived counters onto each usage row as
`cachedTokens` / `cache_creation_input_tokens`. **So in `mirrors/litellm/*.json`
the field `cachedTokens` IS the cache-READ (hit) token count, and it is a SUBSET of
`promptTokens`.** It is not a separate additive bucket, and it is not a write count.

## 6. Aggregate mirror totals are the sum over requests, with no divisor

`budget_reservation.py`, the day builder in `proxy/spend_tracking/`, and
`spend_counter_batch.py` all accumulate by addition only. There is no place in
LiteLLM that divides a pool by a period. A day total equals the sum of its
per-request costs — the mirror's `usage-daily.json` values are therefore
authoritative additively, and any TokenLab-side dedup must **never** subtract a
pool back out of a total (that is how half of all cache went missing).

## 7. `cachedTokens` is a mirror-specific export artifact, not a LiteLLM DB column

The VPS UI's `/usage` export aggregates `prompt_tokens_details` per request and
rewrites the day's numbers. It emits the day both as a whole-day row and as
duplicated `byModel` views, and it fills `cachedTokens` only on the provider-native
`rawModel` key. Both facts are visible in the mirror — 2026-08-31:

```
day                 in=1310221946  out=7806517  cache=2176363904  req=22797  cost=1000.37
kimi-k3|openai      in=1209500081  out=6795583  cache=1088118336  req=20782  cost=467.01
openai/Kimi-k3|…    in=1209500081  out=6795583  cache=1088118336  req=20782  cost=467.01
```

Two keys, one `rawModel` (`openai/Kimi-k3`), byte-identical values. This is why
`groupDailyByModel` must dedupe by `rawModel` and must **keep** the cache it finds;
summing the twin keys is the only double-count, and discarding their cache — which
the old remainder guard did — is the under-count.

### Correction to `tests/router-usage.test.ts`

The test *"does not restate a day's cache on an unattributed remainder row"* asserted
that the 2026-08-31 day cache must equal **half** the mirror value, reasoning that
the half is "the truth". The half is not the truth: the provider-native value the
test calls "the composite, already equals the whole day" is `openai/Kimi-k3`, the
identity of the model — while the bare `kimi-k3` key is the *same view under a
different key*, not a peer component. The per-request history that the test cites as
proof (10-08: history 2,185,984 vs daily 4,371,968) is the set LiteLLM's **own rate
table**, which publishes a 0.1× cache-read rate for `kimi-k3`, cannot bill — so both
halves were charged as full-price input weight and the split is not observable there.

Corroboration that the mirror's day cache is right and the old parse was short:
`Kimi-k3` is a 1T-class model, and 1,088,118,336 cached + 1,209,500,081 fresh =
2.30B prompt tokens for 20,782 requests is ~110k prompt/req — exactly the shape this
mirror bills everywhere else. Halving it would mean a 1M-context model caching
nothing while paying full price.

The two affected tests are rewritten to assert the real invariant:
`cacheReadTokens === day.cachedTokens` exactly, with the twins deduped once.

