/**
 * Model Data Crawler
 * Crawl thông tin models từ OpenRouter API và các nguồn khác
 * Chạy: npx tsx src/crawler.ts hoặc npm run update-models
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Đường dẫn lưu data
const DATA_DIR = path.join(__dirname, '..', 'data');
const MODELS_FILE = path.join(DATA_DIR, 'models.json');
const PRICING_FILE = path.join(DATA_DIR, 'pricing.json');
const ENCODINGS_FILE = path.join(DATA_DIR, 'encodings.json');

// Interfaces
interface OpenRouterModel {
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

interface ModelInfo {
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

interface CrawlResult {
    success: boolean;
    source: string;
    modelsCount: number;
    timestamp: string;
    models: ModelInfo[];
}

// Encoding mapping cho token counting
const TOKENIZER_TO_ENCODING: Record<string, string> = {
    tiktoken: 'cl100k_base',
    cl100k_base: 'cl100k_base',
    o200k_base: 'o200k_base',
    p50k_base: 'p50k_base',
    r50k_base: 'r50k_base',
    // Các model mới của OpenAI thường dùng o200k_base
    'gpt-4o': 'o200k_base',
    'gpt-4': 'cl100k_base',
    claude: 'cl100k_base',
    llama: 'cl100k_base',
    mistral: 'cl100k_base',
    gemini: 'cl100k_base',
};

/**
 * Xác định encoding dựa trên model ID
 */
function determineEncoding(modelId: string, tokenizer?: string): string {
    // Nếu có tokenizer info
    if (tokenizer && TOKENIZER_TO_ENCODING[tokenizer]) {
        return TOKENIZER_TO_ENCODING[tokenizer];
    }

    // Xác định theo model ID
    const id = modelId.toLowerCase();

    // OpenAI o200k_base models
    if (id.includes('gpt-4o') || id.includes('o1') || id.includes('o3')) {
        return 'o200k_base';
    }

    // OpenAI cl100k_base models
    if (id.includes('gpt-4') || id.includes('gpt-3.5')) {
        return 'cl100k_base';
    }

    // Legacy OpenAI
    if (
        id.includes('davinci') ||
        id.includes('curie') ||
        id.includes('babbage') ||
        id.includes('ada')
    ) {
        if (id.includes('text-davinci-003') || id.includes('text-davinci-002')) {
            return 'p50k_base';
        }
        return 'r50k_base';
    }

    // Mặc định dùng cl100k_base cho các model khác
    return 'cl100k_base';
}

/**
 * Trích xuất provider từ model ID
 */
function extractProvider(modelId: string): string {
    const parts = modelId.split('/');
    if (parts.length > 1) {
        return parts[0];
    }

    // Xác định provider từ tên model
    const id = modelId.toLowerCase();
    if (id.includes('gpt') || id.includes('o1') || id.includes('o3')) return 'openai';
    if (id.includes('claude')) return 'anthropic';
    if (id.includes('gemini')) return 'google';
    if (id.includes('llama')) return 'meta-llama';
    if (id.includes('mistral') || id.includes('mixtral')) return 'mistralai';
    if (id.includes('deepseek')) return 'deepseek';
    if (id.includes('qwen')) return 'qwen';
    if (id.includes('command') || id.includes('embed')) return 'cohere';
    if (id.includes('grok')) return 'x-ai';
    if (id.includes('titan') || id.includes('nova')) return 'amazon';
    if (id.includes('jamba') || id.includes('j2')) return 'ai21';
    if (id.includes('yi')) return '01-ai';
    if (id.includes('glm')) return 'zhipu';

    return 'unknown';
}

/**
 * Crawl models từ OpenRouter API
 */
async function crawlOpenRouter(): Promise<CrawlResult> {
    console.log('📡 Crawling from OpenRouter API...');

    try {
        const response = await fetch('https://openrouter.ai/api/v1/models');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = (await response.json()) as { data: OpenRouterModel[] };
        const models: ModelInfo[] = [];

        for (const model of data.data) {
            // Parse pricing (giá per token -> per 1M tokens)
            const inputPrice = parseFloat(model.pricing.prompt) * 1_000_000;
            const outputPrice = parseFloat(model.pricing.completion) * 1_000_000;

            const modelInfo: ModelInfo = {
                id: model.id,
                name: model.name || model.id.split('/').pop() || model.id,
                provider: extractProvider(model.id),
                description: model.description || '',
                contextWindow: model.context_length || model.top_provider?.context_length || 4096,
                maxOutputTokens: model.top_provider?.max_completion_tokens,
                inputPricePer1M: Math.round(inputPrice * 1000000) / 1000000,
                outputPricePer1M: Math.round(outputPrice * 1000000) / 1000000,
                modality: model.architecture?.modality,
                tokenizer: model.architecture?.tokenizer,
                isModerated: model.top_provider?.is_moderated,
                lastUpdated: new Date().toISOString(),
            };

            models.push(modelInfo);
        }

        console.log(`✅ Found ${models.length} models from OpenRouter`);

        return {
            success: true,
            source: 'openrouter',
            modelsCount: models.length,
            timestamp: new Date().toISOString(),
            models,
        };
    } catch (error) {
        console.error('❌ Failed to crawl OpenRouter:', error);
        return {
            success: false,
            source: 'openrouter',
            modelsCount: 0,
            timestamp: new Date().toISOString(),
            models: [],
        };
    }
}

/**
 * Tạo file encoding mapping từ models data
 */
function generateEncodingMap(models: ModelInfo[]): Record<string, string> {
    const encodings: Record<string, string> = {};

    for (const model of models) {
        // Dùng ID ngắn (không có provider prefix)
        const shortId = model.id.includes('/') ? model.id.split('/').pop()! : model.id;
        encodings[shortId] = determineEncoding(model.id, model.tokenizer);

        // Cũng lưu full ID
        encodings[model.id] = determineEncoding(model.id, model.tokenizer);
    }

    return encodings;
}

/**
 * Tạo file pricing từ models data
 */
function generatePricingMap(models: ModelInfo[]): Record<
    string,
    {
        name: string;
        inputPricePer1M: number;
        outputPricePer1M: number;
        contextWindow: number;
        description: string;
    }
> {
    const pricing: Record<
        string,
        {
            name: string;
            inputPricePer1M: number;
            outputPricePer1M: number;
            contextWindow: number;
            description: string;
        }
    > = {};

    for (const model of models) {
        // Dùng ID ngắn cho key
        const shortId = model.id.includes('/') ? model.id.split('/').pop()! : model.id;

        pricing[shortId] = {
            name: model.name,
            inputPricePer1M: model.inputPricePer1M,
            outputPricePer1M: model.outputPricePer1M,
            contextWindow: model.contextWindow,
            description: model.description || `${model.provider} model`,
        };
    }

    return pricing;
}

/**
 * Lưu dữ liệu vào files
 */
function saveData(result: CrawlResult): void {
    // Tạo thư mục data nếu chưa có
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        console.log('📁 Created data directory');
    }

    // Lưu full models data
    const modelsData = {
        lastUpdated: result.timestamp,
        source: result.source,
        count: result.modelsCount,
        models: result.models,
    };
    fs.writeFileSync(MODELS_FILE, JSON.stringify(modelsData, null, 2));
    console.log(`💾 Saved ${result.modelsCount} models to ${MODELS_FILE}`);

    // Lưu pricing map
    const pricingMap = generatePricingMap(result.models);
    const pricingData = {
        lastUpdated: result.timestamp,
        source: result.source,
        count: Object.keys(pricingMap).length,
        pricing: pricingMap,
    };
    fs.writeFileSync(PRICING_FILE, JSON.stringify(pricingData, null, 2));
    console.log(`💾 Saved pricing data to ${PRICING_FILE}`);

    // Lưu encoding map
    const encodingMap = generateEncodingMap(result.models);
    const encodingData = {
        lastUpdated: result.timestamp,
        count: Object.keys(encodingMap).length,
        encodings: encodingMap,
    };
    fs.writeFileSync(ENCODINGS_FILE, JSON.stringify(encodingData, null, 2));
    console.log(`💾 Saved encoding data to ${ENCODINGS_FILE}`);
}

/**
 * Main function
 */
async function main(): Promise<void> {
    console.log('🚀 MCP TokenSage - Model Data Crawler');
    console.log('=====================================\n');

    const startTime = Date.now();

    // Crawl từ OpenRouter
    const result = await crawlOpenRouter();

    if (result.success && result.models.length > 0) {
        // Lưu dữ liệu
        saveData(result);

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`\n✨ Crawl completed in ${elapsed}s`);
        console.log(`📊 Total models: ${result.modelsCount}`);

        // Thống kê theo provider
        const providers = new Map<string, number>();
        for (const model of result.models) {
            providers.set(model.provider, (providers.get(model.provider) || 0) + 1);
        }

        console.log('\n📈 Models by provider:');
        const sortedProviders = [...providers.entries()].sort((a, b) => b[1] - a[1]);
        for (const [provider, count] of sortedProviders.slice(0, 15)) {
            console.log(`   ${provider}: ${count}`);
        }
    } else {
        console.error('\n❌ Crawl failed! Using existing data if available.');
        process.exit(1);
    }
}

// Run
main().catch(console.error);
