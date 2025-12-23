#!/usr/bin/env node
/**
 * MCP TokenSage - MCP Server for Token Counting, Usage Tracking and Cost Calculation
 * 
 * Tools:
 * - count_tokens: Đếm số token trong text
 * - record_usage: Ghi nhận lượng token sử dụng
 * - get_usage_stats: Lấy thống kê sử dụng
 * - calculate_cost: Tính chi phí
 * - compare_models: So sánh chi phí giữa các models
 * - get_pricing: Lấy bảng giá các models
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    Tool,
} from '@modelcontextprotocol/sdk/types.js';

import { countTokens, countTokensBatch, getSupportedModels, cleanupEncoders } from './tokenCounter.js';
import { UsageTracker, getGlobalTracker } from './usageTracker.js';
import { calculateCost, compareCosts, getAvailableModels, estimateProjectCost } from './costCalculator.js';

// Tool definitions
const TOOLS: Tool[] = [
    {
        name: 'count_tokens',
        description: 'Đếm số token trong text sử dụng tiktoken. Hỗ trợ các model GPT-4, GPT-3.5, Claude, etc.',
        inputSchema: {
            type: 'object',
            properties: {
                text: {
                    type: 'string',
                    description: 'Text cần đếm token',
                },
                model: {
                    type: 'string',
                    description: 'Model để xác định encoding (default: gpt-4)',
                    default: 'gpt-4',
                },
                include_tokens: {
                    type: 'boolean',
                    description: 'Có trả về danh sách token IDs không (default: false)',
                    default: false,
                },
            },
            required: ['text'],
        },
    },
    {
        name: 'count_tokens_batch',
        description: 'Đếm token cho nhiều text cùng lúc',
        inputSchema: {
            type: 'object',
            properties: {
                texts: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Danh sách các text cần đếm token',
                },
                model: {
                    type: 'string',
                    description: 'Model để xác định encoding (default: gpt-4)',
                    default: 'gpt-4',
                },
            },
            required: ['texts'],
        },
    },
    {
        name: 'record_usage',
        description: 'Ghi nhận lượng token sử dụng cho một request',
        inputSchema: {
            type: 'object',
            properties: {
                model: {
                    type: 'string',
                    description: 'Tên model sử dụng',
                },
                input_tokens: {
                    type: 'number',
                    description: 'Số input tokens',
                },
                output_tokens: {
                    type: 'number',
                    description: 'Số output tokens',
                },
                request_id: {
                    type: 'string',
                    description: 'ID của request (optional)',
                },
            },
            required: ['model', 'input_tokens', 'output_tokens'],
        },
    },
    {
        name: 'get_usage_stats',
        description: 'Lấy thống kê sử dụng token của session hiện tại',
        inputSchema: {
            type: 'object',
            properties: {
                limit: {
                    type: 'number',
                    description: 'Số lượng records gần nhất muốn lấy (optional)',
                },
            },
        },
    },
    {
        name: 'calculate_cost',
        description: 'Tính chi phí cho một request dựa trên số token và model',
        inputSchema: {
            type: 'object',
            properties: {
                model: {
                    type: 'string',
                    description: 'Tên model',
                },
                input_tokens: {
                    type: 'number',
                    description: 'Số input tokens',
                },
                output_tokens: {
                    type: 'number',
                    description: 'Số output tokens',
                },
            },
            required: ['model', 'input_tokens', 'output_tokens'],
        },
    },
    {
        name: 'compare_models',
        description: 'So sánh chi phí giữa các models cho cùng một lượng token',
        inputSchema: {
            type: 'object',
            properties: {
                input_tokens: {
                    type: 'number',
                    description: 'Số input tokens',
                },
                output_tokens: {
                    type: 'number',
                    description: 'Số output tokens',
                },
                models: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Danh sách models muốn so sánh (optional, mặc định là tất cả)',
                },
            },
            required: ['input_tokens', 'output_tokens'],
        },
    },
    {
        name: 'get_pricing',
        description: 'Lấy bảng giá của tất cả các models được hỗ trợ',
        inputSchema: {
            type: 'object',
            properties: {},
        },
    },
    {
        name: 'estimate_project',
        description: 'Ước tính chi phí cho một dự án dựa trên lượng sử dụng hàng ngày',
        inputSchema: {
            type: 'object',
            properties: {
                model: {
                    type: 'string',
                    description: 'Model sử dụng',
                },
                daily_input_tokens: {
                    type: 'number',
                    description: 'Số input tokens trung bình mỗi ngày',
                },
                daily_output_tokens: {
                    type: 'number',
                    description: 'Số output tokens trung bình mỗi ngày',
                },
                days: {
                    type: 'number',
                    description: 'Số ngày muốn ước tính (default: 30)',
                    default: 30,
                },
            },
            required: ['model', 'daily_input_tokens', 'daily_output_tokens'],
        },
    },
    {
        name: 'get_supported_models',
        description: 'Lấy danh sách các models được hỗ trợ cho token counting',
        inputSchema: {
            type: 'object',
            properties: {},
        },
    },
    {
        name: 'reset_usage',
        description: 'Reset thống kê sử dụng',
        inputSchema: {
            type: 'object',
            properties: {},
        },
    },
];

// Create server
const server = new Server(
    {
        name: 'mcp-tokensage',
        version: '1.0.0',
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

// Handle list tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tracker = getGlobalTracker();

    try {
        switch (name) {
            case 'count_tokens': {
                const text = args?.text as string;
                const model = (args?.model as string) || 'gpt-4';
                const includeTokens = (args?.include_tokens as boolean) || false;

                const result = countTokens(text, model, includeTokens);
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(result, null, 2),
                        },
                    ],
                };
            }

            case 'count_tokens_batch': {
                const texts = args?.texts as string[];
                const model = (args?.model as string) || 'gpt-4';

                const result = countTokensBatch(texts, model);
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(result, null, 2),
                        },
                    ],
                };
            }

            case 'record_usage': {
                const model = args?.model as string;
                const inputTokens = args?.input_tokens as number;
                const outputTokens = args?.output_tokens as number;
                const requestId = args?.request_id as string | undefined;

                const record = tracker.recordUsage(model, inputTokens, outputTokens, requestId);
                const cost = calculateCost(model, inputTokens, outputTokens);

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({ record, cost }, null, 2),
                        },
                    ],
                };
            }

            case 'get_usage_stats': {
                const limit = args?.limit as number | undefined;

                const stats = tracker.getStats();
                const records = tracker.getRecords(limit);

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({ stats, recentRecords: records }, null, 2),
                        },
                    ],
                };
            }

            case 'calculate_cost': {
                const model = args?.model as string;
                const inputTokens = args?.input_tokens as number;
                const outputTokens = args?.output_tokens as number;

                const result = calculateCost(model, inputTokens, outputTokens);
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(result, null, 2),
                        },
                    ],
                };
            }

            case 'compare_models': {
                const inputTokens = args?.input_tokens as number;
                const outputTokens = args?.output_tokens as number;
                const models = args?.models as string[] | undefined;

                const results = compareCosts(inputTokens, outputTokens, models);
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(results, null, 2),
                        },
                    ],
                };
            }

            case 'get_pricing': {
                const models = getAvailableModels();
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(models, null, 2),
                        },
                    ],
                };
            }

            case 'estimate_project': {
                const model = args?.model as string;
                const dailyInput = args?.daily_input_tokens as number;
                const dailyOutput = args?.daily_output_tokens as number;
                const days = (args?.days as number) || 30;

                const result = estimateProjectCost(model, dailyInput, dailyOutput, days);
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(result, null, 2),
                        },
                    ],
                };
            }

            case 'get_supported_models': {
                const models = getSupportedModels();
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({ models }, null, 2),
                        },
                    ],
                };
            }

            case 'reset_usage': {
                tracker.reset();
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({ message: 'Usage statistics reset successfully', sessionId: tracker.getSessionId() }, null, 2),
                        },
                    ],
                };
            }

            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({ error: errorMessage }, null, 2),
                },
            ],
            isError: true,
        };
    }
});

// Cleanup on exit
process.on('SIGINT', () => {
    cleanupEncoders();
    process.exit(0);
});

process.on('SIGTERM', () => {
    cleanupEncoders();
    process.exit(0);
});

// Start server
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('MCP TokenSage server started');
}

main().catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
});
