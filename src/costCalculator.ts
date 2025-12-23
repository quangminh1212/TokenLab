/**
 * Cost Calculator - Tính chi phí sử dụng token theo model
 */

export interface ModelPricing {
    name: string;
    inputPricePer1M: number;  // USD per 1M tokens
    outputPricePer1M: number; // USD per 1M tokens
    contextWindow: number;
    description?: string;
}

// Pricing data (cập nhật tháng 12/2024)
export const MODEL_PRICING: Record<string, ModelPricing> = {
    // OpenAI GPT-4o
    'gpt-4o': {
        name: 'GPT-4o',
        inputPricePer1M: 2.50,
        outputPricePer1M: 10.00,
        contextWindow: 128000,
        description: 'Most capable GPT-4 model',
    },
    'gpt-4o-mini': {
        name: 'GPT-4o Mini',
        inputPricePer1M: 0.15,
        outputPricePer1M: 0.60,
        contextWindow: 128000,
        description: 'Affordable GPT-4o variant',
    },
    // OpenAI GPT-4
    'gpt-4-turbo': {
        name: 'GPT-4 Turbo',
        inputPricePer1M: 10.00,
        outputPricePer1M: 30.00,
        contextWindow: 128000,
        description: 'GPT-4 with 128K context',
    },
    'gpt-4': {
        name: 'GPT-4',
        inputPricePer1M: 30.00,
        outputPricePer1M: 60.00,
        contextWindow: 8192,
        description: 'Original GPT-4 8K model',
    },
    // OpenAI GPT-3.5
    'gpt-3.5-turbo': {
        name: 'GPT-3.5 Turbo',
        inputPricePer1M: 0.50,
        outputPricePer1M: 1.50,
        contextWindow: 16385,
        description: 'Fast and affordable',
    },
    // Anthropic Claude 3.5
    'claude-3.5-sonnet': {
        name: 'Claude 3.5 Sonnet',
        inputPricePer1M: 3.00,
        outputPricePer1M: 15.00,
        contextWindow: 200000,
        description: 'Best Claude model for most tasks',
    },
    'claude-3.5-haiku': {
        name: 'Claude 3.5 Haiku',
        inputPricePer1M: 0.80,
        outputPricePer1M: 4.00,
        contextWindow: 200000,
        description: 'Fast and affordable Claude',
    },
    // Anthropic Claude 3
    'claude-3-opus': {
        name: 'Claude 3 Opus',
        inputPricePer1M: 15.00,
        outputPricePer1M: 75.00,
        contextWindow: 200000,
        description: 'Most powerful Claude model',
    },
    'claude-3-sonnet': {
        name: 'Claude 3 Sonnet',
        inputPricePer1M: 3.00,
        outputPricePer1M: 15.00,
        contextWindow: 200000,
        description: 'Balanced Claude model',
    },
    'claude-3-haiku': {
        name: 'Claude 3 Haiku',
        inputPricePer1M: 0.25,
        outputPricePer1M: 1.25,
        contextWindow: 200000,
        description: 'Fast Claude model',
    },
    // Google Gemini
    'gemini-1.5-pro': {
        name: 'Gemini 1.5 Pro',
        inputPricePer1M: 1.25,
        outputPricePer1M: 5.00,
        contextWindow: 2000000,
        description: 'Google most capable model',
    },
    'gemini-1.5-flash': {
        name: 'Gemini 1.5 Flash',
        inputPricePer1M: 0.075,
        outputPricePer1M: 0.30,
        contextWindow: 1000000,
        description: 'Fast Google model',
    },
    // Deepseek
    'deepseek-chat': {
        name: 'Deepseek Chat',
        inputPricePer1M: 0.14,
        outputPricePer1M: 0.28,
        contextWindow: 64000,
        description: 'Affordable Chinese model',
    },
};

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

/**
 * Tính chi phí cho một request
 */
export function calculateCost(
    model: string,
    inputTokens: number,
    outputTokens: number
): CostResult {
    // Tìm pricing phù hợp
    let pricing = MODEL_PRICING[model.toLowerCase()];

    if (!pricing) {
        // Thử tìm theo prefix
        for (const [key, value] of Object.entries(MODEL_PRICING)) {
            if (model.toLowerCase().includes(key.toLowerCase())) {
                pricing = value;
                break;
            }
        }
    }

    // Default pricing nếu không tìm thấy
    if (!pricing) {
        pricing = {
            name: model,
            inputPricePer1M: 1.00,
            outputPricePer1M: 2.00,
            contextWindow: 8192,
            description: 'Unknown model - using default pricing',
        };
    }

    const inputCost = (inputTokens / 1_000_000) * pricing.inputPricePer1M;
    const outputCost = (outputTokens / 1_000_000) * pricing.outputPricePer1M;
    const totalCost = inputCost + outputCost;

    return {
        model,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        inputCost: Math.round(inputCost * 1_000_000) / 1_000_000, // 6 decimal places
        outputCost: Math.round(outputCost * 1_000_000) / 1_000_000,
        totalCost: Math.round(totalCost * 1_000_000) / 1_000_000,
        currency: 'USD',
        pricing,
    };
}

/**
 * So sánh chi phí giữa các models
 */
export function compareCosts(
    inputTokens: number,
    outputTokens: number,
    models?: string[]
): CostResult[] {
    const modelsToCompare = models || Object.keys(MODEL_PRICING);

    return modelsToCompare
        .map(model => calculateCost(model, inputTokens, outputTokens))
        .sort((a, b) => a.totalCost - b.totalCost);
}

/**
 * Lấy danh sách models và pricing
 */
export function getAvailableModels(): ModelPricing[] {
    return Object.values(MODEL_PRICING).sort((a, b) =>
        a.inputPricePer1M - b.inputPricePer1M
    );
}

/**
 * Ước tính chi phí cho một dự án
 */
export function estimateProjectCost(
    model: string,
    dailyInputTokens: number,
    dailyOutputTokens: number,
    days: number = 30
): {
    daily: CostResult;
    monthly: CostResult;
    projected: CostResult;
} {
    const daily = calculateCost(model, dailyInputTokens, dailyOutputTokens);
    const monthly = calculateCost(model, dailyInputTokens * 30, dailyOutputTokens * 30);
    const projected = calculateCost(model, dailyInputTokens * days, dailyOutputTokens * days);

    return { daily, monthly, projected };
}
