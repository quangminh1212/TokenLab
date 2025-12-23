/**
 * Unit Tests for Cost Calculator Module
 */

import { describe, it, expect } from '@jest/globals';
import {
    calculateCost,
    compareCosts,
    getAvailableModels,
    estimateProjectCost,
    getModelsCount,
    isModelSupported,
} from '../src/costCalculator.js';

describe('CostCalculator', () => {
    describe('calculateCost', () => {
        it('should calculate cost for GPT-4o', () => {
            const result = calculateCost('gpt-4o', 1000, 2000);
            expect(result.model).toBe('gpt-4o');
            expect(result.inputTokens).toBe(1000);
            expect(result.outputTokens).toBe(2000);
            expect(result.totalTokens).toBe(3000);
            expect(result.currency).toBe('USD');
            expect(result.totalCost).toBeGreaterThan(0);
        });

        it('should calculate input and output costs separately', () => {
            const result = calculateCost('gpt-4o', 1000000, 0);
            expect(result.inputCost).toBeGreaterThan(0);
            expect(result.outputCost).toBe(0);

            const result2 = calculateCost('gpt-4o', 0, 1000000);
            expect(result2.inputCost).toBe(0);
            expect(result2.outputCost).toBeGreaterThan(0);
        });

        it('should handle unknown models with default pricing', () => {
            const result = calculateCost('unknown-model-xyz', 1000, 1000);
            expect(result.pricing).toBeDefined();
            expect(result.totalCost).toBeGreaterThan(0);
        });

        it('should handle zero tokens', () => {
            const result = calculateCost('gpt-4o', 0, 0);
            expect(result.totalCost).toBe(0);
        });
    });

    describe('compareCosts', () => {
        it('should compare costs across models', () => {
            const results = compareCosts(10000, 20000, ['gpt-4o', 'gpt-4o-mini']);
            expect(results).toHaveLength(2);
            // Results should be sorted by cost (ascending)
            expect(results[0].totalCost).toBeLessThanOrEqual(results[1].totalCost);
        });

        it('should return all models when no filter specified', () => {
            const results = compareCosts(1000, 1000);
            expect(results.length).toBeGreaterThan(0);
        });
    });

    describe('getAvailableModels', () => {
        it('should return sorted array of models', () => {
            const models = getAvailableModels();
            expect(Array.isArray(models)).toBe(true);
            expect(models.length).toBeGreaterThan(0);

            // Should be sorted by input price
            for (let i = 1; i < models.length; i++) {
                expect(models[i].inputPricePer1M).toBeGreaterThanOrEqual(
                    models[i - 1].inputPricePer1M
                );
            }
        });
    });

    describe('estimateProjectCost', () => {
        it('should estimate daily, monthly, and projected costs', () => {
            const result = estimateProjectCost('gpt-4o', 100000, 200000, 30);
            expect(result.daily).toBeDefined();
            expect(result.monthly).toBeDefined();
            expect(result.projected).toBeDefined();

            // Monthly should be 30x daily
            expect(result.monthly.inputTokens).toBe(result.daily.inputTokens * 30);
        });

        it('should use default 30 days when not specified', () => {
            const result = estimateProjectCost('gpt-4o', 1000, 1000);
            expect(result.projected.inputTokens).toBe(30000);
        });
    });

    describe('getModelsCount', () => {
        it('should return positive number', () => {
            const count = getModelsCount();
            expect(count).toBeGreaterThan(0);
        });
    });

    describe('isModelSupported', () => {
        it('should return true for known models', () => {
            expect(isModelSupported('gpt-4o')).toBe(true);
            expect(isModelSupported('gpt-4')).toBe(true);
        });

        it('should return false for unknown models', () => {
            expect(isModelSupported('completely-fake-model-12345')).toBe(false);
        });
    });
});
