/**
 * Usage Tracker - Theo dõi lượng token sử dụng theo session và tổng cộng
 */

import type { UsageRecord, UsageStats, ModelUsageStats } from './types.js';

// Re-export types
export type { UsageRecord, UsageStats, ModelUsageStats };

export class UsageTracker {
    private records: UsageRecord[] = [];
    private sessionId: string;

    constructor(sessionId?: string) {
        this.sessionId = sessionId || this.generateSessionId();
    }

    private generateSessionId(): string {
        return `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    }

    getSessionId(): string {
        return this.sessionId;
    }

    /**
     * Ghi nhận một request mới
     */
    recordUsage(
        model: string,
        inputTokens: number,
        outputTokens: number,
        requestId?: string,
        metadata?: Record<string, unknown>
    ): UsageRecord {
        const record: UsageRecord = {
            timestamp: new Date(),
            model,
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
            requestId,
            metadata,
        };

        this.records.push(record);
        return record;
    }

    /**
     * Lấy thống kê sử dụng
     */
    getStats(): UsageStats {
        const stats: UsageStats = {
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalTokens: 0,
            requestCount: this.records.length,
            averageTokensPerRequest: 0,
            firstRequest: null,
            lastRequest: null,
            byModel: {},
        };

        if (this.records.length === 0) {
            return stats;
        }

        for (const record of this.records) {
            stats.totalInputTokens += record.inputTokens;
            stats.totalOutputTokens += record.outputTokens;
            stats.totalTokens += record.totalTokens;

            // Thống kê theo model
            if (!stats.byModel[record.model]) {
                stats.byModel[record.model] = {
                    inputTokens: 0,
                    outputTokens: 0,
                    totalTokens: 0,
                    requestCount: 0,
                };
            }
            stats.byModel[record.model].inputTokens += record.inputTokens;
            stats.byModel[record.model].outputTokens += record.outputTokens;
            stats.byModel[record.model].totalTokens += record.totalTokens;
            stats.byModel[record.model].requestCount += 1;
        }

        stats.averageTokensPerRequest = stats.totalTokens / this.records.length;
        stats.firstRequest = this.records[0].timestamp;
        stats.lastRequest = this.records[this.records.length - 1].timestamp;

        return stats;
    }

    /**
     * Lấy lịch sử records
     */
    getRecords(limit?: number): UsageRecord[] {
        if (limit) {
            return this.records.slice(-limit);
        }
        return [...this.records];
    }

    /**
     * Lấy records theo khoảng thời gian
     */
    getRecordsByTimeRange(startTime: Date, endTime: Date): UsageRecord[] {
        return this.records.filter(
            record => record.timestamp >= startTime && record.timestamp <= endTime
        );
    }

    /**
     * Lấy records theo model
     */
    getRecordsByModel(model: string): UsageRecord[] {
        return this.records.filter(record =>
            record.model.toLowerCase().includes(model.toLowerCase())
        );
    }

    /**
     * Reset session
     */
    reset(): void {
        this.records = [];
        this.sessionId = this.generateSessionId();
    }

    /**
     * Export data để lưu trữ
     */
    exportData(): { sessionId: string; records: UsageRecord[] } {
        return {
            sessionId: this.sessionId,
            records: this.records,
        };
    }

    /**
     * Import data từ lưu trữ
     */
    importData(data: { sessionId: string; records: UsageRecord[] }): void {
        this.sessionId = data.sessionId;
        this.records = data.records.map(r => ({
            ...r,
            timestamp: new Date(r.timestamp),
        }));
    }
}

// Singleton instance cho global tracking
let globalTracker: UsageTracker | null = null;

export function getGlobalTracker(): UsageTracker {
    if (!globalTracker) {
        globalTracker = new UsageTracker('global');
    }
    return globalTracker;
}

export function resetGlobalTracker(): void {
    globalTracker = null;
}
