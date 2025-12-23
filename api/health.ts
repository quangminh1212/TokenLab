/**
 * Health Check Endpoint
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

const MODEL_COUNT = 15; // Subset for serverless

export default function handler(req: VercelRequest, res: VercelResponse) {
    res.setHeader('Access-Control-Allow-Origin', '*');

    const health = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        mode: 'serverless',
        stats: {
            pricingModels: MODEL_COUNT,
            tokenCountingMethod: 'estimation',
        },
        note: 'For full 350+ models with exact token counting, use local MCP server.',
    };

    res.status(200).json(health);
}
