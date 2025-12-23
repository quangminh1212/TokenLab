/**
 * MCP TokenSage - HTTP API Handler
 * Serverless function for Vercel deployment
 * Note: Uses estimation instead of tiktoken for Vercel compatibility
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

// ============ Inline implementations for Vercel (avoid tiktoken WASM issues) ============

// Simplified token estimation (tiktoken not compatible with some serverless)
function estimateTokens(text: string): number {
    // Average: 1 token ≈ 4 characters for English
    // This is an approximation, tiktoken gives exact count
    return Math.ceil(text.length / 4);
}

// Model pricing data (subset for API)
const MODEL_PRICING: Record<
    string,
    { name: string; inputPricePer1M: number; outputPricePer1M: number; contextWindow: number }
> = {
    'gpt-4o': {
        name: 'GPT-4o',
        inputPricePer1M: 2.5,
        outputPricePer1M: 10.0,
        contextWindow: 128000,
    },
    'gpt-4o-mini': {
        name: 'GPT-4o Mini',
        inputPricePer1M: 0.15,
        outputPricePer1M: 0.6,
        contextWindow: 128000,
    },
    'gpt-4-turbo': {
        name: 'GPT-4 Turbo',
        inputPricePer1M: 10.0,
        outputPricePer1M: 30.0,
        contextWindow: 128000,
    },
    'gpt-4': { name: 'GPT-4', inputPricePer1M: 30.0, outputPricePer1M: 60.0, contextWindow: 8192 },
    'gpt-3.5-turbo': {
        name: 'GPT-3.5 Turbo',
        inputPricePer1M: 0.5,
        outputPricePer1M: 1.5,
        contextWindow: 16385,
    },
    'claude-3.5-sonnet': {
        name: 'Claude 3.5 Sonnet',
        inputPricePer1M: 3.0,
        outputPricePer1M: 15.0,
        contextWindow: 200000,
    },
    'claude-3.5-haiku': {
        name: 'Claude 3.5 Haiku',
        inputPricePer1M: 0.8,
        outputPricePer1M: 4.0,
        contextWindow: 200000,
    },
    'claude-3-opus': {
        name: 'Claude 3 Opus',
        inputPricePer1M: 15.0,
        outputPricePer1M: 75.0,
        contextWindow: 200000,
    },
    'gemini-1.5-pro': {
        name: 'Gemini 1.5 Pro',
        inputPricePer1M: 1.25,
        outputPricePer1M: 5.0,
        contextWindow: 2000000,
    },
    'gemini-1.5-flash': {
        name: 'Gemini 1.5 Flash',
        inputPricePer1M: 0.075,
        outputPricePer1M: 0.3,
        contextWindow: 1000000,
    },
    'deepseek-chat': {
        name: 'DeepSeek Chat',
        inputPricePer1M: 0.14,
        outputPricePer1M: 0.28,
        contextWindow: 64000,
    },
    'llama-3.3-70b': {
        name: 'Llama 3.3 70B',
        inputPricePer1M: 0.59,
        outputPricePer1M: 0.79,
        contextWindow: 128000,
    },
    'mistral-large': {
        name: 'Mistral Large',
        inputPricePer1M: 2.0,
        outputPricePer1M: 6.0,
        contextWindow: 128000,
    },
    o1: { name: 'o1', inputPricePer1M: 15.0, outputPricePer1M: 60.0, contextWindow: 200000 },
    'o1-mini': {
        name: 'o1 Mini',
        inputPricePer1M: 3.0,
        outputPricePer1M: 12.0,
        contextWindow: 128000,
    },
};

function calculateCost(model: string, inputTokens: number, outputTokens: number) {
    const pricing = MODEL_PRICING[model.toLowerCase()] || {
        name: model,
        inputPricePer1M: 1.0,
        outputPricePer1M: 2.0,
        contextWindow: 8192,
    };

    const inputCost = (inputTokens / 1_000_000) * pricing.inputPricePer1M;
    const outputCost = (outputTokens / 1_000_000) * pricing.outputPricePer1M;

    return {
        model,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        inputCost: Math.round(inputCost * 1_000_000) / 1_000_000,
        outputCost: Math.round(outputCost * 1_000_000) / 1_000_000,
        totalCost: Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000,
        currency: 'USD',
        pricing,
    };
}

// In-memory usage tracker
interface UsageRecord {
    timestamp: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
}

let usageRecords: UsageRecord[] = [];
let sessionId = `vercel_${Date.now()}`;

// ============ Tool handlers ============
const toolHandlers: Record<string, (args: Record<string, unknown>) => unknown> = {
    count_tokens: args => {
        const text = args.text as string;
        const model = (args.model as string) || 'gpt-4';
        const tokenCount = estimateTokens(text);
        return {
            text: text.length > 100 ? text.substring(0, 100) + '...' : text,
            tokenCount,
            model,
            encoding: 'estimated',
            note: 'Token count is estimated (≈4 chars/token). Use local MCP server for exact counts.',
        };
    },

    count_tokens_batch: args => {
        const texts = args.texts as string[];
        const model = (args.model as string) || 'gpt-4';
        const results = texts.map(text => ({
            text: text.length > 50 ? text.substring(0, 50) + '...' : text,
            tokenCount: estimateTokens(text),
            model,
        }));
        return {
            results,
            totalTokens: results.reduce((sum, r) => sum + r.tokenCount, 0),
            note: 'Token counts are estimated.',
        };
    },

    record_usage: args => {
        const model = args.model as string;
        const inputTokens = args.input_tokens as number;
        const outputTokens = args.output_tokens as number;

        const record: UsageRecord = {
            timestamp: new Date().toISOString(),
            model,
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
        };
        usageRecords.push(record);

        return {
            record,
            cost: calculateCost(model, inputTokens, outputTokens),
        };
    },

    get_usage_stats: args => {
        const limit = args.limit as number | undefined;
        const records = limit ? usageRecords.slice(-limit) : usageRecords;

        const totalInputTokens = usageRecords.reduce((sum, r) => sum + r.inputTokens, 0);
        const totalOutputTokens = usageRecords.reduce((sum, r) => sum + r.outputTokens, 0);

        return {
            stats: {
                totalInputTokens,
                totalOutputTokens,
                totalTokens: totalInputTokens + totalOutputTokens,
                requestCount: usageRecords.length,
                averageTokensPerRequest:
                    usageRecords.length > 0
                        ? (totalInputTokens + totalOutputTokens) / usageRecords.length
                        : 0,
            },
            recentRecords: records,
            sessionId,
        };
    },

    calculate_cost: args => {
        const model = args.model as string;
        const inputTokens = args.input_tokens as number;
        const outputTokens = args.output_tokens as number;
        return calculateCost(model, inputTokens, outputTokens);
    },

    compare_models: args => {
        const inputTokens = args.input_tokens as number;
        const outputTokens = args.output_tokens as number;
        const models = (args.models as string[] | undefined) || Object.keys(MODEL_PRICING);

        return models
            .map(model => calculateCost(model, inputTokens, outputTokens))
            .sort((a, b) => a.totalCost - b.totalCost);
    },

    get_pricing: () => {
        return Object.entries(MODEL_PRICING)
            .map(([id, p]) => ({ id, ...p }))
            .sort((a, b) => a.inputPricePer1M - b.inputPricePer1M);
    },

    estimate_project: args => {
        const model = args.model as string;
        const dailyInput = args.daily_input_tokens as number;
        const dailyOutput = args.daily_output_tokens as number;
        const days = (args.days as number) || 30;

        return {
            daily: calculateCost(model, dailyInput, dailyOutput),
            monthly: calculateCost(model, dailyInput * 30, dailyOutput * 30),
            projected: calculateCost(model, dailyInput * days, dailyOutput * days),
        };
    },

    get_supported_models: () => {
        return {
            models: Object.keys(MODEL_PRICING),
            totalModels: Object.keys(MODEL_PRICING).length,
            note: 'For full 350+ models, use local MCP server with crawler data.',
        };
    },

    reset_usage: () => {
        usageRecords = [];
        sessionId = `vercel_${Date.now()}`;
        return { message: 'Usage statistics reset', sessionId };
    },
};

// API info
const API_INFO = {
    name: 'MCP TokenSage API',
    version: '1.0.0',
    description: 'Token counting, usage tracking, and cost calculation for LLM APIs',
    mode: 'serverless',
    note: 'Token counting uses estimation. For exact counts, use local MCP server.',
    endpoints: {
        'GET /api/mcp': 'API info and available tools',
        'POST /api/mcp': 'Execute a tool',
        'GET /api/health': 'Health check',
    },
    tools: Object.keys(toolHandlers),
    supportedModels: Object.keys(MODEL_PRICING).length,
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // CORS preflight
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    // GET - Return API info
    if (req.method === 'GET') {
        res.status(200).json(API_INFO);
        return;
    }

    // POST - Execute tool
    if (req.method === 'POST') {
        try {
            const { tool, args = {} } = req.body as {
                tool: string;
                args?: Record<string, unknown>;
            };

            if (!tool) {
                res.status(400).json({ error: 'Missing "tool" parameter' });
                return;
            }

            const handler = toolHandlers[tool];
            if (!handler) {
                res.status(404).json({
                    error: `Unknown tool: ${tool}`,
                    availableTools: Object.keys(toolHandlers),
                });
                return;
            }

            const result = handler(args);
            res.status(200).json({ success: true, result });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            res.status(500).json({ success: false, error: message });
        }
        return;
    }

    res.status(405).json({ error: 'Method not allowed' });
}
