/**
 * Token Counter - Sử dụng tiktoken để đếm token chính xác như GPT models
 */

import { get_encoding, Tiktoken } from 'tiktoken';

export type ModelEncoding = 'cl100k_base' | 'p50k_base' | 'r50k_base' | 'o200k_base';

// Mapping model name to encoding
const MODEL_ENCODINGS: Record<string, ModelEncoding> = {
    // GPT-4 models
    'gpt-4': 'cl100k_base',
    'gpt-4-turbo': 'cl100k_base',
    'gpt-4o': 'o200k_base',
    'gpt-4o-mini': 'o200k_base',
    // GPT-3.5 models
    'gpt-3.5-turbo': 'cl100k_base',
    // Claude models (approximate with cl100k)
    'claude-3': 'cl100k_base',
    'claude-3.5': 'cl100k_base',
    // Legacy models
    'text-davinci-003': 'p50k_base',
    'text-davinci-002': 'p50k_base',
    'davinci': 'r50k_base',
    'curie': 'r50k_base',
    'babbage': 'r50k_base',
    'ada': 'r50k_base',
};

// Cache encoders để tái sử dụng
const encoderCache = new Map<ModelEncoding, Tiktoken>();

function getEncoder(encoding: ModelEncoding): Tiktoken {
    let encoder = encoderCache.get(encoding);
    if (!encoder) {
        encoder = get_encoding(encoding);
        encoderCache.set(encoding, encoder);
    }
    return encoder;
}

export function getEncodingForModel(model: string): ModelEncoding {
    // Tìm encoding phù hợp nhất
    for (const [key, encoding] of Object.entries(MODEL_ENCODINGS)) {
        if (model.toLowerCase().includes(key.toLowerCase())) {
            return encoding;
        }
    }
    // Default to cl100k_base (GPT-4/3.5)
    return 'cl100k_base';
}

export interface TokenCountResult {
    text: string;
    tokenCount: number;
    model: string;
    encoding: ModelEncoding;
    tokens?: number[];
}

/**
 * Đếm số token trong text
 */
export function countTokens(
    text: string,
    model: string = 'gpt-4',
    includeTokens: boolean = false
): TokenCountResult {
    const encoding = getEncodingForModel(model);
    const encoder = getEncoder(encoding);
    const tokens = encoder.encode(text);

    return {
        text: text.length > 100 ? text.substring(0, 100) + '...' : text,
        tokenCount: tokens.length,
        model,
        encoding,
        ...(includeTokens && { tokens: Array.from(tokens) }),
    };
}

/**
 * Đếm token cho nhiều text cùng lúc
 */
export function countTokensBatch(
    texts: string[],
    model: string = 'gpt-4'
): { results: TokenCountResult[]; totalTokens: number } {
    const results = texts.map(text => countTokens(text, model));
    const totalTokens = results.reduce((sum, r) => sum + r.tokenCount, 0);

    return { results, totalTokens };
}

/**
 * Ước tính token từ character count (nhanh hơn nhưng kém chính xác)
 */
export function estimateTokens(text: string): number {
    // Trung bình 1 token ~ 4 characters cho tiếng Anh
    // Tiếng Việt và các ngôn ngữ khác có thể khác
    return Math.ceil(text.length / 4);
}

/**
 * Lấy danh sách models được hỗ trợ
 */
export function getSupportedModels(): string[] {
    return Object.keys(MODEL_ENCODINGS);
}

/**
 * Cleanup encoders khi không cần thiết
 */
export function cleanupEncoders(): void {
    for (const encoder of encoderCache.values()) {
        encoder.free();
    }
    encoderCache.clear();
}
