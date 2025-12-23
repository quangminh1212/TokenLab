/**
 * Model Data Loader
 * Load thông tin models từ JSON files (được crawl từ API)
 * Fallback về hardcoded data nếu không có file
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Đường dẫn data files
const DATA_DIR = path.join(__dirname, '..', 'data');
const MODELS_FILE = path.join(DATA_DIR, 'models.json');
const PRICING_FILE = path.join(DATA_DIR, 'pricing.json');
const ENCODINGS_FILE = path.join(DATA_DIR, 'encodings.json');

// Interfaces
export interface ModelPricing {
    name: string;
    inputPricePer1M: number;
    outputPricePer1M: number;
    contextWindow: number;
    description: string;
}

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

export type ModelEncoding = 'cl100k_base' | 'p50k_base' | 'r50k_base' | 'o200k_base';

// Cache loaded data
let cachedModels: ModelInfo[] | null = null;
let cachedPricing: Record<string, ModelPricing> | null = null;
let cachedEncodings: Record<string, ModelEncoding> | null = null;
let lastLoadTime: number = 0;

// Cache timeout (5 phút)
const CACHE_TIMEOUT = 5 * 60 * 1000;

/**
 * Load models data từ file
 */
export function loadModels(forceReload: boolean = false): ModelInfo[] {
    const now = Date.now();

    if (!forceReload && cachedModels && now - lastLoadTime < CACHE_TIMEOUT) {
        return cachedModels;
    }

    try {
        if (fs.existsSync(MODELS_FILE)) {
            const data = JSON.parse(fs.readFileSync(MODELS_FILE, 'utf-8'));
            cachedModels = data.models || [];
            lastLoadTime = now;
            return cachedModels!;
        }
    } catch (error) {
        console.error('Failed to load models.json:', error);
    }

    return [];
}

/**
 * Load pricing data từ file
 */
export function loadPricing(forceReload: boolean = false): Record<string, ModelPricing> {
    const now = Date.now();

    if (!forceReload && cachedPricing && now - lastLoadTime < CACHE_TIMEOUT) {
        return cachedPricing;
    }

    try {
        if (fs.existsSync(PRICING_FILE)) {
            const data = JSON.parse(fs.readFileSync(PRICING_FILE, 'utf-8'));
            cachedPricing = data.pricing || {};
            lastLoadTime = now;
            return cachedPricing!;
        }
    } catch (error) {
        console.error('Failed to load pricing.json:', error);
    }

    return {};
}

/**
 * Load encoding data từ file
 */
export function loadEncodings(forceReload: boolean = false): Record<string, ModelEncoding> {
    const now = Date.now();

    if (!forceReload && cachedEncodings && now - lastLoadTime < CACHE_TIMEOUT) {
        return cachedEncodings;
    }

    try {
        if (fs.existsSync(ENCODINGS_FILE)) {
            const data = JSON.parse(fs.readFileSync(ENCODINGS_FILE, 'utf-8'));
            cachedEncodings = data.encodings || {};
            lastLoadTime = now;
            return cachedEncodings as Record<string, ModelEncoding>;
        }
    } catch (error) {
        console.error('Failed to load encodings.json:', error);
    }

    return {};
}

/**
 * Kiểm tra xem data files có tồn tại không
 */
export function hasDataFiles(): boolean {
    return (
        fs.existsSync(MODELS_FILE) && fs.existsSync(PRICING_FILE) && fs.existsSync(ENCODINGS_FILE)
    );
}

/**
 * Lấy thời gian data được cập nhật lần cuối
 */
export function getLastUpdateTime(): Date | null {
    try {
        if (fs.existsSync(MODELS_FILE)) {
            const data = JSON.parse(fs.readFileSync(MODELS_FILE, 'utf-8'));
            return new Date(data.lastUpdated);
        }
    } catch {
        // Ignore
    }
    return null;
}

/**
 * Lấy số lượng models đã load
 */
export function getModelsCount(): number {
    const models = loadModels();
    return models.length;
}

/**
 * Tìm model theo ID
 */
export function findModel(modelId: string): ModelInfo | undefined {
    const models = loadModels();
    const id = modelId.toLowerCase();

    return models.find(
        m =>
            m.id.toLowerCase() === id ||
            m.id.toLowerCase().endsWith('/' + id) ||
            m.name.toLowerCase() === id
    );
}

/**
 * Lấy pricing cho model
 */
export function getModelPricing(modelId: string): ModelPricing | undefined {
    const pricing = loadPricing();
    const id = modelId.toLowerCase();

    // Thử tìm exact match
    if (pricing[id]) {
        return pricing[id];
    }

    // Thử tìm partial match
    for (const [key, value] of Object.entries(pricing)) {
        if (key.toLowerCase().includes(id) || id.includes(key.toLowerCase())) {
            return value;
        }
    }

    return undefined;
}

/**
 * Lấy encoding cho model
 */
export function getModelEncoding(modelId: string): ModelEncoding {
    const encodings = loadEncodings();
    const id = modelId.toLowerCase();

    // Thử tìm exact match
    if (encodings[id]) {
        return encodings[id];
    }

    // Thử tìm partial match
    for (const [key, value] of Object.entries(encodings)) {
        if (key.toLowerCase().includes(id) || id.includes(key.toLowerCase())) {
            return value;
        }
    }

    // Default encoding
    return 'cl100k_base';
}

/**
 * Lấy danh sách providers
 */
export function getProviders(): string[] {
    const models = loadModels();
    const providers = new Set(models.map(m => m.provider));
    return [...providers].sort();
}

/**
 * Lấy models theo provider
 */
export function getModelsByProvider(provider: string): ModelInfo[] {
    const models = loadModels();
    return models.filter(m => m.provider.toLowerCase() === provider.toLowerCase());
}

/**
 * Clear cache
 */
export function clearCache(): void {
    cachedModels = null;
    cachedPricing = null;
    cachedEncodings = null;
    lastLoadTime = 0;
}

/**
 * Lấy thông tin tổng quan
 */
export function getDataSummary(): {
    hasData: boolean;
    modelsCount: number;
    pricingCount: number;
    encodingsCount: number;
    providersCount: number;
    lastUpdated: Date | null;
} {
    const models = loadModels();
    const pricing = loadPricing();
    const encodings = loadEncodings();

    return {
        hasData: hasDataFiles(),
        modelsCount: models.length,
        pricingCount: Object.keys(pricing).length,
        encodingsCount: Object.keys(encodings).length,
        providersCount: new Set(models.map(m => m.provider)).size,
        lastUpdated: getLastUpdateTime(),
    };
}
