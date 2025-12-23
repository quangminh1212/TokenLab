/**
 * Health Check Endpoint
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getModelsCount } from '../src/costCalculator.js';
import { getSupportedModels } from '../src/tokenCounter.js';

export default function handler(req: VercelRequest, res: VercelResponse) {
    const health = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        stats: {
            pricingModels: getModelsCount(),
            tokenCountingModels: getSupportedModels().length,
        }
    };

    res.status(200).json(health);
}
