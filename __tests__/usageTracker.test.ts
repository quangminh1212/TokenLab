/**
 * Unit Tests for Usage Tracker Module
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { UsageTracker } from '../src/usageTracker.js';

describe('UsageTracker', () => {
    let tracker: UsageTracker;

    beforeEach(() => {
        tracker = new UsageTracker('test-session');
    });

    describe('constructor', () => {
        it('should create tracker with provided session ID', () => {
            const customTracker = new UsageTracker('custom-session');
            expect(customTracker.getSessionId()).toBe('custom-session');
        });

        it('should generate session ID when not provided', () => {
            const autoTracker = new UsageTracker();
            expect(autoTracker.getSessionId()).toMatch(/^session_\d+_/);
        });
    });

    describe('recordUsage', () => {
        it('should record usage correctly', () => {
            const record = tracker.recordUsage('gpt-4o', 100, 200);
            expect(record.model).toBe('gpt-4o');
            expect(record.inputTokens).toBe(100);
            expect(record.outputTokens).toBe(200);
            expect(record.totalTokens).toBe(300);
            expect(record.timestamp).toBeInstanceOf(Date);
        });

        it('should store request ID if provided', () => {
            const record = tracker.recordUsage('gpt-4o', 100, 200, 'req-123');
            expect(record.requestId).toBe('req-123');
        });
    });

    describe('getStats', () => {
        it('should return empty stats when no records', () => {
            const stats = tracker.getStats();
            expect(stats.totalTokens).toBe(0);
            expect(stats.requestCount).toBe(0);
            expect(stats.averageTokensPerRequest).toBe(0);
        });

        it('should calculate stats correctly', () => {
            tracker.recordUsage('gpt-4o', 100, 200);
            tracker.recordUsage('gpt-4o', 50, 100);

            const stats = tracker.getStats();
            expect(stats.totalInputTokens).toBe(150);
            expect(stats.totalOutputTokens).toBe(300);
            expect(stats.totalTokens).toBe(450);
            expect(stats.requestCount).toBe(2);
            expect(stats.averageTokensPerRequest).toBe(225);
        });

        it('should track stats by model', () => {
            tracker.recordUsage('gpt-4o', 100, 100);
            tracker.recordUsage('claude-3.5-sonnet', 50, 50);

            const stats = tracker.getStats();
            expect(stats.byModel['gpt-4o'].totalTokens).toBe(200);
            expect(stats.byModel['claude-3.5-sonnet'].totalTokens).toBe(100);
        });
    });

    describe('getRecords', () => {
        it('should return all records', () => {
            tracker.recordUsage('gpt-4o', 100, 100);
            tracker.recordUsage('gpt-4o', 200, 200);
            tracker.recordUsage('gpt-4o', 300, 300);

            const records = tracker.getRecords();
            expect(records).toHaveLength(3);
        });

        it('should limit records when specified', () => {
            tracker.recordUsage('gpt-4o', 100, 100);
            tracker.recordUsage('gpt-4o', 200, 200);
            tracker.recordUsage('gpt-4o', 300, 300);

            const records = tracker.getRecords(2);
            expect(records).toHaveLength(2);
            // Should return the last 2 records
            expect(records[0].inputTokens).toBe(200);
            expect(records[1].inputTokens).toBe(300);
        });
    });

    describe('getRecordsByModel', () => {
        it('should filter records by model', () => {
            tracker.recordUsage('gpt-4o', 100, 100);
            tracker.recordUsage('claude-3.5-sonnet', 200, 200);
            tracker.recordUsage('gpt-4o', 300, 300);

            const gptRecords = tracker.getRecordsByModel('gpt-4o');
            expect(gptRecords).toHaveLength(2);
        });
    });

    describe('reset', () => {
        it('should clear all records and generate new session ID', () => {
            const originalSessionId = tracker.getSessionId();
            tracker.recordUsage('gpt-4o', 100, 100);
            tracker.reset();

            expect(tracker.getRecords()).toHaveLength(0);
            expect(tracker.getSessionId()).not.toBe(originalSessionId);
        });
    });

    describe('exportData / importData', () => {
        it('should export and import data correctly', () => {
            tracker.recordUsage('gpt-4o', 100, 100);
            tracker.recordUsage('claude', 200, 200);

            const exported = tracker.exportData();
            expect(exported.sessionId).toBe('test-session');
            expect(exported.records).toHaveLength(2);

            const newTracker = new UsageTracker();
            newTracker.importData(exported);

            expect(newTracker.getSessionId()).toBe('test-session');
            expect(newTracker.getRecords()).toHaveLength(2);
        });
    });
});
