/**
 * Configuration Constants
 * Tập trung các constants và configuration của dự án
 */

// ==================== Paths ====================
export const DATA_DIR = 'data';
export const MODELS_FILE = 'models.json';
export const PRICING_FILE = 'pricing.json';
export const ENCODINGS_FILE = 'encodings.json';

// ==================== Cache ====================
/** Cache timeout in milliseconds (5 minutes) */
export const CACHE_TIMEOUT_MS = 5 * 60 * 1000;

// ==================== API Endpoints ====================
export const API_ENDPOINTS = {
    OPENROUTER_MODELS: 'https://openrouter.ai/api/v1/models',
} as const;

// ==================== Token Encodings ====================
export type ModelEncoding = 'cl100k_base' | 'p50k_base' | 'r50k_base' | 'o200k_base';

/** Default encoding for unknown models */
export const DEFAULT_ENCODING: ModelEncoding = 'cl100k_base';

/** Encoding for different model families */
export const ENCODING_BY_MODEL_FAMILY: Record<string, ModelEncoding> = {
    // o200k_base models (newer OpenAI)
    'gpt-4o': 'o200k_base',
    'o1': 'o200k_base',
    'o3': 'o200k_base',
    // cl100k_base models
    'gpt-4': 'cl100k_base',
    'gpt-3.5': 'cl100k_base',
    'claude': 'cl100k_base',
    'gemini': 'cl100k_base',
    'llama': 'cl100k_base',
    'mistral': 'cl100k_base',
    'mixtral': 'cl100k_base',
    'deepseek': 'cl100k_base',
    'qwen': 'cl100k_base',
    'command': 'cl100k_base',
    // p50k_base models (legacy)
    'text-davinci': 'p50k_base',
    'code-davinci': 'p50k_base',
    // r50k_base models (old)
    'davinci': 'r50k_base',
    'curie': 'r50k_base',
    'babbage': 'r50k_base',
    'ada': 'r50k_base',
};

// ==================== Pricing Defaults ====================
/** Default pricing when model is not found (USD per 1M tokens) */
export const DEFAULT_PRICING = {
    inputPricePer1M: 1.00,
    outputPricePer1M: 2.00,
    contextWindow: 8192,
    description: 'Unknown model - using default pricing',
} as const;

// ==================== Provider Aliases ====================
/** Map provider aliases to standard names */
export const PROVIDER_ALIASES: Record<string, string> = {
    'openai': 'openai',
    'anthropic': 'anthropic',
    'google': 'google',
    'meta': 'meta-llama',
    'meta-llama': 'meta-llama',
    'mistral': 'mistralai',
    'mistralai': 'mistralai',
    'deepseek': 'deepseek',
    'alibaba': 'qwen',
    'qwen': 'qwen',
    'cohere': 'cohere',
    'xai': 'x-ai',
    'x-ai': 'x-ai',
    'amazon': 'amazon',
    'ai21': 'ai21',
    'perplexity': 'perplexity',
};

// ==================== Estimation Defaults ====================
export const ESTIMATION_DEFAULTS = {
    /** Default number of days for project estimation */
    DAYS: 30,
    /** Average tokens per word (English) */
    TOKENS_PER_WORD: 1.3,
    /** Average characters per token */
    CHARS_PER_TOKEN: 4,
} as const;

// ==================== Formatting ====================
export const FORMATTING = {
    /** Number of decimal places for cost display */
    COST_DECIMALS: 6,
    /** Number of decimal places for percentage */
    PERCENT_DECIMALS: 2,
    /** Currency symbol */
    CURRENCY: 'USD',
    /** Currency symbol for display */
    CURRENCY_SYMBOL: '$',
} as const;

// ==================== Rate Limits ====================
export const RATE_LIMITS = {
    /** Minimum delay between API calls (ms) */
    MIN_API_DELAY: 100,
    /** Maximum retries for API calls */
    MAX_RETRIES: 3,
    /** Retry delay (ms) */
    RETRY_DELAY: 1000,
} as const;

// ==================== Validation ====================
export const VALIDATION = {
    /** Maximum text length for token counting */
    MAX_TEXT_LENGTH: 10_000_000, // 10MB
    /** Maximum batch size */
    MAX_BATCH_SIZE: 1000,
    /** Maximum tokens to include in response */
    MAX_TOKENS_IN_RESPONSE: 10000,
} as const;
