/**
 * MCP TokenSage - HTTP API Handler
 * Serverless function for Vercel deployment
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { countTokens, countTokensBatch, getSupportedModels, estimateTokens } from '../src/tokenCounter.js';
import { calculateCost, compareCosts, getAvailableModels, estimateProjectCost, getModelsCount } from '../src/costCalculator.js';
import { UsageTracker } from '../src/usageTracker.js';

// In-memory usage tracker (will reset on cold start)
const tracker = new UsageTracker('vercel-session');

// Tool handlers
const toolHandlers: Record<string, (args: Record<string, unknown>) => unknown> = {
    count_tokens: (args) => {
        const text = args.text as string;
        const model = (args.model as string) || 'gpt-4';
        const includeTokens = (args.include_tokens as boolean) || false;
        return countTokens(text, model, includeTokens);
    },

    count_tokens_batch: (args) => {
        const texts = args.texts as string[];
        const model = (args.model as string) || 'gpt-4';
        return countTokensBatch(texts, model);
    },

    estimate_tokens: (args) => {
        const text = args.text as string;
        return { estimatedTokens: estimateTokens(text) };
    },

    record_usage: (args) => {
        const model = args.model as string;
        const inputTokens = args.input_tokens as number;
        const outputTokens = args.output_tokens as number;
        const requestId = args.request_id as string | undefined;

        const record = tracker.recordUsage(model, inputTokens, outputTokens, requestId);
        const cost = calculateCost(model, inputTokens, outputTokens);
        return { record, cost };
    },

    get_usage_stats: (args) => {
        const limit = args.limit as number | undefined;
        const stats = tracker.getStats();
        const records = tracker.getRecords(limit);
        return { stats, recentRecords: records };
    },

    calculate_cost: (args) => {
        const model = args.model as string;
        const inputTokens = args.input_tokens as number;
        const outputTokens = args.output_tokens as number;
        return calculateCost(model, inputTokens, outputTokens);
    },

    compare_models: (args) => {
        const inputTokens = args.input_tokens as number;
        const outputTokens = args.output_tokens as number;
        const models = args.models as string[] | undefined;
        return compareCosts(inputTokens, outputTokens, models);
    },

    get_pricing: () => {
        return getAvailableModels();
    },

    estimate_project: (args) => {
        const model = args.model as string;
        const dailyInput = args.daily_input_tokens as number;
        const dailyOutput = args.daily_output_tokens as number;
        const days = (args.days as number) || 30;
        return estimateProjectCost(model, dailyInput, dailyOutput, days);
    },

    get_supported_models: () => {
        return {
            models: getSupportedModels(),
            totalPricingModels: getModelsCount()
        };
    },

    reset_usage: () => {
        tracker.reset();
        return {
            message: 'Usage statistics reset successfully',
            sessionId: tracker.getSessionId()
        };
    },
};

// API info
const API_INFO = {
    name: 'MCP TokenSage API',
    version: '1.0.0',
    description: 'Token counting, usage tracking, and cost calculation for LLM APIs',
    endpoints: {
        'GET /api/mcp': 'API info and available tools',
        'POST /api/mcp': 'Execute a tool',
        'GET /api/mcp/health': 'Health check',
    },
    tools: Object.keys(toolHandlers),
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
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
            const { tool, args = {} } = req.body as { tool: string; args?: Record<string, unknown> };

            if (!tool) {
                res.status(400).json({ error: 'Missing "tool" parameter' });
                return;
            }

            const handler = toolHandlers[tool];
            if (!handler) {
                res.status(404).json({
                    error: `Unknown tool: ${tool}`,
                    availableTools: Object.keys(toolHandlers)
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
