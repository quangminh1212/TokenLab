/**
 * Type Definitions
 * Tập trung các type và interface của dự án
 */

// ==================== Model Types ====================

/** Tiktoken encoding types */
export type ModelEncoding = 'cl100k_base' | 'p50k_base' | 'r50k_base' | 'o200k_base';

/** Model pricing information */
export interface ModelPricing {
    name: string;
    inputPricePer1M: number;
    outputPricePer1M: number;
    contextWindow: number;
    description?: string;
}

/** Full model information from crawler */
export interface ModelInfo {
    id: string;
    name: string;
    provider: string;
    description: string;
    contextWindow: number;
    maxOutputTokens?: number;
    inputPricePer1M: number;
    outputPricePer1M: number;
    modality?: string;
    tokenizer?: string;
    isModerated?: boolean;
    lastUpdated: string;
}

// ==================== Token Counter Types ====================

/** Result of token counting */
export interface TokenCountResult {
    text: string;
    tokenCount: number;
    model: string;
    encoding: ModelEncoding;
    tokens?: number[];
}

/** Batch token count result */
export interface TokenBatchResult {
    results: TokenCountResult[];
    totalTokens: number;
}

// ==================== Usage Tracker Types ====================

/** Single usage record */
export interface UsageRecord {
    timestamp: Date;
    model: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    requestId?: string;
    metadata?: Record<string, unknown>;
}

/** Usage statistics */
export interface UsageStats {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
    requestCount: number;
    averageTokensPerRequest: number;
    firstRequest: Date | null;
    lastRequest: Date | null;
    byModel: Record<string, ModelUsageStats>;
}

/** Per-model usage statistics */
export interface ModelUsageStats {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    requestCount: number;
}

// ==================== Cost Calculator Types ====================

/** Cost calculation result */
export interface CostResult {
    model: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    inputCost: number;
    outputCost: number;
    totalCost: number;
    currency: string;
    pricing: ModelPricing;
}

/** Project cost estimation */
export interface ProjectEstimation {
    daily: CostResult;
    monthly: CostResult;
    projected: CostResult;
}

// ==================== Crawler Types ====================

/** OpenRouter API model response */
export interface OpenRouterModel {
    id: string;
    name: string;
    description?: string;
    context_length: number;
    pricing: {
        prompt: string;
        completion: string;
        request?: string;
        image?: string;
    };
    top_provider?: {
        context_length?: number;
        max_completion_tokens?: number;
        is_moderated?: boolean;
    };
    per_request_limits?: unknown;
    architecture?: {
        modality?: string;
        tokenizer?: string;
        instruct_type?: string;
    };
}

/** Crawl result */
export interface CrawlResult {
    success: boolean;
    source: string;
    modelsCount: number;
    timestamp: string;
    models: ModelInfo[];
}

// ==================== Data Loader Types ====================

/** Data file structure for models */
export interface ModelsDataFile {
    lastUpdated: string;
    source: string;
    count: number;
    models: ModelInfo[];
}

/** Data file structure for pricing */
export interface PricingDataFile {
    lastUpdated: string;
    source: string;
    count: number;
    pricing: Record<string, ModelPricing>;
}

/** Data file structure for encodings */
export interface EncodingsDataFile {
    lastUpdated: string;
    count: number;
    encodings: Record<string, ModelEncoding>;
}

/** Data summary */
export interface DataSummary {
    hasData: boolean;
    modelsCount: number;
    pricingCount: number;
    encodingsCount: number;
    providersCount: number;
    lastUpdated: Date | null;
}

// ==================== MCP Types ====================

/** Tool call arguments - generic */
export type ToolArgs = Record<string, unknown>;

/** Tool response content */
export interface ToolContent {
    type: 'text';
    text: string;
}

/** Tool response */
export interface ToolResponse {
    content: ToolContent[];
    isError?: boolean;
}
