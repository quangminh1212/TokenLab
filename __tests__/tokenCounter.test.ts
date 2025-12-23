/**
 * Unit Tests for Token Counter Module
 */

import { describe, it, expect, afterAll } from '@jest/globals';
import {
    countTokens,
    countTokensBatch,
    estimateTokens,
    getSupportedModels,
    getEncodingForModel,
    cleanupEncoders,
} from '../src/tokenCounter.js';

describe('TokenCounter', () => {
    afterAll(() => {
        cleanupEncoders();
    });

    describe('countTokens', () => {
        it('should count tokens for simple English text', () => {
            const result = countTokens('Hello, world!', 'gpt-4');
            expect(result.tokenCount).toBeGreaterThan(0);
            expect(result.model).toBe('gpt-4');
            expect(result.encoding).toBe('cl100k_base');
        });

        it('should handle empty string', () => {
            const result = countTokens('', 'gpt-4');
            expect(result.tokenCount).toBe(0);
        });

        it('should use default model when not specified', () => {
            const result = countTokens('Test text');
            expect(result.model).toBe('gpt-4');
        });

        it('should include tokens array when requested', () => {
            const result = countTokens('Hello', 'gpt-4', true);
            expect(result.tokens).toBeDefined();
            expect(Array.isArray(result.tokens)).toBe(true);
        });

        it('should truncate long text in result', () => {
            const longText = 'x'.repeat(200);
            const result = countTokens(longText, 'gpt-4');
            expect(result.text.length).toBeLessThanOrEqual(103); // 100 + "..."
        });
    });

    describe('countTokensBatch', () => {
        it('should count tokens for multiple texts', () => {
            const texts = ['Hello', 'World', 'Test'];
            const result = countTokensBatch(texts, 'gpt-4');
            expect(result.results).toHaveLength(3);
            expect(result.totalTokens).toBeGreaterThan(0);
        });

        it('should handle empty array', () => {
            const result = countTokensBatch([], 'gpt-4');
            expect(result.results).toHaveLength(0);
            expect(result.totalTokens).toBe(0);
        });
    });

    describe('estimateTokens', () => {
        it('should estimate tokens based on character count', () => {
            const text = 'Hello, world!'; // 13 characters
            const estimated = estimateTokens(text);
            expect(estimated).toBeGreaterThan(0);
            expect(estimated).toBeLessThanOrEqual(text.length); // Can't be more than char count
        });
    });

    describe('getEncodingForModel', () => {
        it('should return o200k_base for GPT-4o models', () => {
            expect(getEncodingForModel('gpt-4o')).toBe('o200k_base');
            expect(getEncodingForModel('gpt-4o-mini')).toBe('o200k_base');
        });

        it('should return cl100k_base for GPT-4 models', () => {
            expect(getEncodingForModel('gpt-4')).toBe('cl100k_base');
            expect(getEncodingForModel('gpt-4-turbo')).toBe('cl100k_base');
        });

        it('should return cl100k_base for unknown models', () => {
            expect(getEncodingForModel('unknown-model')).toBe('cl100k_base');
        });
    });

    describe('getSupportedModels', () => {
        it('should return array of supported models', () => {
            const models = getSupportedModels();
            expect(Array.isArray(models)).toBe(true);
            expect(models.length).toBeGreaterThan(0);
            expect(models).toContain('gpt-4');
            expect(models).toContain('gpt-4o');
        });
    });
});
