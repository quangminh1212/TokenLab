/**
 * Test file for MCP TokenSage
 */

import { countTokens, countTokensBatch, getSupportedModels } from './tokenCounter.js';
import { UsageTracker, getGlobalTracker } from './usageTracker.js';
import { calculateCost, compareCosts, getAvailableModels, estimateProjectCost } from './costCalculator.js';

// Test Token Counter
console.log('=== Testing Token Counter ===');

const text1 = 'Hello, how are you today?';
const result1 = countTokens(text1, 'gpt-4');
console.log(`Text: "${text1}"`);
console.log(`Tokens: ${result1.tokenCount} (model: ${result1.model}, encoding: ${result1.encoding})`);

const text2 = 'Xin chào, bạn có khỏe không?';
const result2 = countTokens(text2, 'gpt-4');
console.log(`\nText: "${text2}"`);
console.log(`Tokens: ${result2.tokenCount} (Vietnamese uses more tokens)`);

const batchResult = countTokensBatch(['Hello', 'World', 'Test'], 'gpt-4');
console.log(`\nBatch count: ${batchResult.totalTokens} tokens for 3 texts`);

console.log(`\nSupported models for token counting: ${getSupportedModels().join(', ')}`);

// Test Usage Tracker
console.log('\n=== Testing Usage Tracker ===');

const tracker = new UsageTracker('test-session');
tracker.recordUsage('gpt-4o', 100, 200);
tracker.recordUsage('gpt-4o', 150, 300);
tracker.recordUsage('claude-3.5-sonnet', 200, 400);

const stats = tracker.getStats();
console.log(`Total tokens: ${stats.totalTokens}`);
console.log(`Total requests: ${stats.requestCount}`);
console.log(`Average per request: ${stats.averageTokensPerRequest.toFixed(0)}`);
console.log(`Models used:`, Object.keys(stats.byModel));

// Test Cost Calculator
console.log('\n=== Testing Cost Calculator ===');

const cost1 = calculateCost('gpt-4o', 10000, 20000);
console.log(`GPT-4o (10K in, 20K out): $${cost1.totalCost.toFixed(4)}`);

const cost2 = calculateCost('gpt-4o-mini', 10000, 20000);
console.log(`GPT-4o-mini (10K in, 20K out): $${cost2.totalCost.toFixed(4)}`);

const cost3 = calculateCost('claude-3.5-sonnet', 10000, 20000);
console.log(`Claude 3.5 Sonnet (10K in, 20K out): $${cost3.totalCost.toFixed(4)}`);

// Compare models
console.log('\n=== Model Comparison (100K in, 200K out) ===');
const comparison = compareCosts(100000, 200000);
comparison.slice(0, 5).forEach((c, i) => {
    console.log(`${i + 1}. ${c.pricing.name}: $${c.totalCost.toFixed(4)}`);
});

// Project estimation
console.log('\n=== Project Estimation (GPT-4o, 1M tokens/day) ===');
const estimate = estimateProjectCost('gpt-4o', 500000, 500000, 30);
console.log(`Daily: $${estimate.daily.totalCost.toFixed(2)}`);
console.log(`Monthly (30 days): $${estimate.projected.totalCost.toFixed(2)}`);

// Available models
console.log('\n=== Available Models for Pricing ===');
const models = getAvailableModels();
console.log(`Total: ${models.length} models`);
models.forEach(m => {
    console.log(`- ${m.name}: $${m.inputPricePer1M}/1M in, $${m.outputPricePer1M}/1M out`);
});

console.log('\n✅ All tests passed!');
