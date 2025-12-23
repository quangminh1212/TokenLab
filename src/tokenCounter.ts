/**
 * Token Counter - Sử dụng tiktoken để đếm token chính xác như GPT models
 */

import { get_encoding, Tiktoken } from 'tiktoken';

export type ModelEncoding = 'cl100k_base' | 'p50k_base' | 'r50k_base' | 'o200k_base';

// Mapping model name to encoding
// Note: Non-OpenAI models use approximate encodings (cl100k_base or o200k_base)
const MODEL_ENCODINGS: Record<string, ModelEncoding> = {
    // ==================== OpenAI Models ====================
    // GPT-4o Series (o200k_base encoding)
    'gpt-4o': 'o200k_base',
    'gpt-4o-2024-11-20': 'o200k_base',
    'gpt-4o-2024-08-06': 'o200k_base',
    'gpt-4o-2024-05-13': 'o200k_base',
    'gpt-4o-mini': 'o200k_base',
    'gpt-4o-mini-2024-07-18': 'o200k_base',
    'chatgpt-4o-latest': 'o200k_base',
    // GPT-4 Turbo Series
    'gpt-4-turbo': 'cl100k_base',
    'gpt-4-turbo-2024-04-09': 'cl100k_base',
    'gpt-4-turbo-preview': 'cl100k_base',
    'gpt-4-0125-preview': 'cl100k_base',
    'gpt-4-1106-preview': 'cl100k_base',
    'gpt-4-vision-preview': 'cl100k_base',
    // GPT-4 Base Series
    'gpt-4': 'cl100k_base',
    'gpt-4-0613': 'cl100k_base',
    'gpt-4-0314': 'cl100k_base',
    'gpt-4-32k': 'cl100k_base',
    'gpt-4-32k-0613': 'cl100k_base',
    // GPT-3.5 Turbo Series
    'gpt-3.5-turbo': 'cl100k_base',
    'gpt-3.5-turbo-0125': 'cl100k_base',
    'gpt-3.5-turbo-1106': 'cl100k_base',
    'gpt-3.5-turbo-16k': 'cl100k_base',
    'gpt-3.5-turbo-instruct': 'cl100k_base',
    // OpenAI o1/o3 Reasoning Models
    'o1': 'o200k_base',
    'o1-2024-12-17': 'o200k_base',
    'o1-preview': 'o200k_base',
    'o1-preview-2024-09-12': 'o200k_base',
    'o1-mini': 'o200k_base',
    'o1-mini-2024-09-12': 'o200k_base',
    'o3-mini': 'o200k_base',
    // OpenAI Embeddings
    'text-embedding-3-large': 'cl100k_base',
    'text-embedding-3-small': 'cl100k_base',
    'text-embedding-ada-002': 'cl100k_base',
    // Legacy OpenAI Models
    'text-davinci-003': 'p50k_base',
    'text-davinci-002': 'p50k_base',
    'code-davinci-002': 'p50k_base',
    'davinci': 'r50k_base',
    'curie': 'r50k_base',
    'babbage': 'r50k_base',
    'ada': 'r50k_base',

    // ==================== Anthropic Claude Models ====================
    // Claude 3.5 Series
    'claude-3-5-sonnet-20241022': 'cl100k_base',
    'claude-3-5-sonnet-20240620': 'cl100k_base',
    'claude-3-5-haiku-20241022': 'cl100k_base',
    'claude-3.5-sonnet': 'cl100k_base',
    'claude-3.5-haiku': 'cl100k_base',
    // Claude 3 Series
    'claude-3-opus-20240229': 'cl100k_base',
    'claude-3-sonnet-20240229': 'cl100k_base',
    'claude-3-haiku-20240307': 'cl100k_base',
    'claude-3-opus': 'cl100k_base',
    'claude-3-sonnet': 'cl100k_base',
    'claude-3-haiku': 'cl100k_base',
    // Claude 2 Series
    'claude-2.1': 'cl100k_base',
    'claude-2.0': 'cl100k_base',
    'claude-2': 'cl100k_base',
    'claude-instant-1.2': 'cl100k_base',

    // ==================== Google Models ====================
    // Gemini 2.0
    'gemini-2.0-flash-exp': 'cl100k_base',
    'gemini-2.0-flash-thinking-exp': 'cl100k_base',
    // Gemini 1.5
    'gemini-1.5-pro': 'cl100k_base',
    'gemini-1.5-pro-latest': 'cl100k_base',
    'gemini-1.5-flash': 'cl100k_base',
    'gemini-1.5-flash-latest': 'cl100k_base',
    'gemini-1.5-flash-8b': 'cl100k_base',
    // Gemini 1.0
    'gemini-1.0-pro': 'cl100k_base',
    'gemini-pro': 'cl100k_base',
    'gemini-pro-vision': 'cl100k_base',
    // Google PaLM
    'text-bison-001': 'cl100k_base',
    'chat-bison-001': 'cl100k_base',

    // ==================== Meta Llama Models ====================
    // Llama 3.3
    'llama-3.3-70b': 'cl100k_base',
    'llama-3.3-70b-instruct': 'cl100k_base',
    // Llama 3.2
    'llama-3.2-90b-vision': 'cl100k_base',
    'llama-3.2-11b-vision': 'cl100k_base',
    'llama-3.2-3b': 'cl100k_base',
    'llama-3.2-1b': 'cl100k_base',
    // Llama 3.1
    'llama-3.1-405b': 'cl100k_base',
    'llama-3.1-405b-instruct': 'cl100k_base',
    'llama-3.1-70b': 'cl100k_base',
    'llama-3.1-70b-instruct': 'cl100k_base',
    'llama-3.1-8b': 'cl100k_base',
    'llama-3.1-8b-instruct': 'cl100k_base',
    // Llama 3
    'llama-3-70b': 'cl100k_base',
    'llama-3-70b-instruct': 'cl100k_base',
    'llama-3-8b': 'cl100k_base',
    'llama-3-8b-instruct': 'cl100k_base',
    // Llama 2
    'llama-2-70b': 'cl100k_base',
    'llama-2-70b-chat': 'cl100k_base',
    'llama-2-13b': 'cl100k_base',
    'llama-2-13b-chat': 'cl100k_base',
    'llama-2-7b': 'cl100k_base',
    'llama-2-7b-chat': 'cl100k_base',
    // Code Llama
    'codellama-70b': 'cl100k_base',
    'codellama-34b': 'cl100k_base',
    'codellama-13b': 'cl100k_base',
    'codellama-7b': 'cl100k_base',

    // ==================== Mistral AI Models ====================
    'mistral-large': 'cl100k_base',
    'mistral-large-2411': 'cl100k_base',
    'mistral-large-2407': 'cl100k_base',
    'mistral-medium': 'cl100k_base',
    'mistral-small': 'cl100k_base',
    'mistral-small-2409': 'cl100k_base',
    'mistral-7b': 'cl100k_base',
    'mistral-7b-instruct': 'cl100k_base',
    'mixtral-8x7b': 'cl100k_base',
    'mixtral-8x7b-instruct': 'cl100k_base',
    'mixtral-8x22b': 'cl100k_base',
    'codestral': 'cl100k_base',
    'codestral-2405': 'cl100k_base',
    'pixtral-12b': 'cl100k_base',
    'ministral-3b': 'cl100k_base',
    'ministral-8b': 'cl100k_base',

    // ==================== Cohere Models ====================
    'command-r-plus': 'cl100k_base',
    'command-r': 'cl100k_base',
    'command': 'cl100k_base',
    'command-light': 'cl100k_base',
    'command-nightly': 'cl100k_base',
    'embed-english-v3.0': 'cl100k_base',
    'embed-multilingual-v3.0': 'cl100k_base',
    'rerank-english-v3.0': 'cl100k_base',

    // ==================== DeepSeek Models ====================
    'deepseek-chat': 'cl100k_base',
    'deepseek-coder': 'cl100k_base',
    'deepseek-v3': 'cl100k_base',
    'deepseek-v2.5': 'cl100k_base',
    'deepseek-v2': 'cl100k_base',
    'deepseek-llm-67b': 'cl100k_base',
    'deepseek-coder-33b': 'cl100k_base',

    // ==================== Alibaba Qwen Models ====================
    'qwen-max': 'cl100k_base',
    'qwen-plus': 'cl100k_base',
    'qwen-turbo': 'cl100k_base',
    'qwen-2.5-72b': 'cl100k_base',
    'qwen-2.5-32b': 'cl100k_base',
    'qwen-2.5-14b': 'cl100k_base',
    'qwen-2.5-7b': 'cl100k_base',
    'qwen-2.5-coder-32b': 'cl100k_base',
    'qwen-2-72b': 'cl100k_base',
    'qwen-vl-max': 'cl100k_base',
    'qwen-vl-plus': 'cl100k_base',
    'qwq-32b-preview': 'cl100k_base',

    // ==================== xAI Grok Models ====================
    'grok-2': 'cl100k_base',
    'grok-2-1212': 'cl100k_base',
    'grok-2-vision-1212': 'cl100k_base',
    'grok-beta': 'cl100k_base',
    'grok-vision-beta': 'cl100k_base',

    // ==================== Amazon Models ====================
    'amazon-titan-text-express': 'cl100k_base',
    'amazon-titan-text-lite': 'cl100k_base',
    'amazon-titan-text-premier': 'cl100k_base',
    'amazon-titan-embed-text': 'cl100k_base',
    'amazon-nova-pro': 'cl100k_base',
    'amazon-nova-lite': 'cl100k_base',
    'amazon-nova-micro': 'cl100k_base',

    // ==================== AI21 Models ====================
    'jamba-1.5-large': 'cl100k_base',
    'jamba-1.5-mini': 'cl100k_base',
    'jamba-instruct': 'cl100k_base',
    'j2-ultra': 'cl100k_base',
    'j2-mid': 'cl100k_base',
    'j2-light': 'cl100k_base',

    // ==================== Other Models ====================
    // Perplexity
    'llama-3.1-sonar-large-128k-online': 'cl100k_base',
    'llama-3.1-sonar-small-128k-online': 'cl100k_base',
    'llama-3.1-sonar-huge-128k-online': 'cl100k_base',
    // Together AI
    'together-llama-3-70b': 'cl100k_base',
    'together-mistral-7b': 'cl100k_base',
    // Groq
    'groq-llama-3.3-70b': 'cl100k_base',
    'groq-mixtral-8x7b': 'cl100k_base',
    // Yi (01.AI)
    'yi-large': 'cl100k_base',
    'yi-medium': 'cl100k_base',
    'yi-34b': 'cl100k_base',
    // Baichuan
    'baichuan-2-turbo': 'cl100k_base',
    'baichuan-53b': 'cl100k_base',
    // Zhipu/GLM
    'glm-4': 'cl100k_base',
    'glm-4-plus': 'cl100k_base',
    'glm-4v': 'cl100k_base',
    // Inflection
    'inflection-2.5': 'cl100k_base',
    'inflection-3': 'cl100k_base',
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

// Import loader với try-catch để tránh lỗi khi chưa có data file
let loadedEncodings: Record<string, ModelEncoding> | null = null;

async function tryLoadEncodings(): Promise<Record<string, ModelEncoding>> {
    if (loadedEncodings !== null) {
        return loadedEncodings;
    }

    try {
        const { loadEncodings } = await import('./modelLoader.js');
        loadedEncodings = loadEncodings() as Record<string, ModelEncoding>;
        return loadedEncodings;
    } catch {
        loadedEncodings = {};
        return loadedEncodings;
    }
}

// Khởi tạo load ngay khi module được import
tryLoadEncodings().catch(() => { });

export function getEncodingForModel(model: string): ModelEncoding {
    const modelLower = model.toLowerCase();

    // 1. Thử tìm trong loaded data trước (từ crawler)
    if (loadedEncodings && Object.keys(loadedEncodings).length > 0) {
        // Exact match
        if (loadedEncodings[modelLower]) {
            return loadedEncodings[modelLower];
        }
        // Partial match
        for (const [key, encoding] of Object.entries(loadedEncodings)) {
            if (modelLower.includes(key.toLowerCase()) || key.toLowerCase().includes(modelLower)) {
                return encoding as ModelEncoding;
            }
        }
    }

    // 2. Fallback về hardcoded data
    for (const [key, encoding] of Object.entries(MODEL_ENCODINGS)) {
        if (modelLower.includes(key.toLowerCase())) {
            return encoding;
        }
    }

    // 3. Default to cl100k_base (GPT-4/3.5)
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
