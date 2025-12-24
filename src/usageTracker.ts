/**
 * Usage Tracker - Theo dõi lượng token sử dụng theo session và tổng cộng
 * Hỗ trợ persistent storage để lưu trữ data giữa các sessions
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { UsageRecord, UsageStats, ModelUsageStats } from './types.js';

// Đường dẫn lưu trữ persistent data
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');
const USAGE_FILE = path.join(DATA_DIR, 'usage_history.json');

// Interface cho persistent data
interface PersistentData {
    lastUpdated: string;
    totalStats: {
        totalInputTokens: number;
        totalOutputTokens: number;
        totalTokens: number;
        totalCost: number;
        requestCount: number;
    };
    dailyStats: Record<string, {
        date: string;
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        cost: number;
        requestCount: number;
        models: Record<string, number>;
    }>;
    recentRecords: UsageRecord[];
}

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

// ==================== PERSISTENT STORAGE FUNCTIONS ====================

/**
 * Tạo persistent data mặc định
 */
function createDefaultPersistentData(): PersistentData {
    return {
        lastUpdated: new Date().toISOString(),
        totalStats: {
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalTokens: 0,
            totalCost: 0,
            requestCount: 0,
        },
        dailyStats: {},
        recentRecords: [],
    };
}

/**
 * Load persistent data từ file
 */
export function loadPersistentData(): PersistentData {
    try {
        if (fs.existsSync(USAGE_FILE)) {
            const content = fs.readFileSync(USAGE_FILE, 'utf-8');
            return JSON.parse(content) as PersistentData;
        }
    } catch (error) {
        console.error('Error loading persistent data:', error);
    }
    return createDefaultPersistentData();
}

/**
 * Lưu persistent data vào file
 */
export function savePersistentData(data: PersistentData): void {
    try {
        // Đảm bảo thư mục data tồn tại
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        data.lastUpdated = new Date().toISOString();
        fs.writeFileSync(USAGE_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
        console.error('Error saving persistent data:', error);
    }
}

/**
 * Ghi nhận usage và lưu persistent (tự động track)
 */
export function recordUsagePersistent(
    model: string,
    inputTokens: number,
    outputTokens: number,
    cost: number,
    requestId?: string
): {
    record: UsageRecord;
    dailyTotal: { inputTokens: number; outputTokens: number; totalTokens: number; cost: number };
    allTimeTotal: { inputTokens: number; outputTokens: number; totalTokens: number; cost: number };
} {
    const data = loadPersistentData();
    const today = new Date().toISOString().split('T')[0];

    // Tạo record mới
    const record: UsageRecord = {
        timestamp: new Date(),
        model,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        requestId,
    };

    // Cập nhật total stats
    data.totalStats.totalInputTokens += inputTokens;
    data.totalStats.totalOutputTokens += outputTokens;
    data.totalStats.totalTokens += inputTokens + outputTokens;
    data.totalStats.totalCost += cost;
    data.totalStats.requestCount += 1;

    // Cập nhật daily stats
    if (!data.dailyStats[today]) {
        data.dailyStats[today] = {
            date: today,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            cost: 0,
            requestCount: 0,
            models: {},
        };
    }
    data.dailyStats[today].inputTokens += inputTokens;
    data.dailyStats[today].outputTokens += outputTokens;
    data.dailyStats[today].totalTokens += inputTokens + outputTokens;
    data.dailyStats[today].cost += cost;
    data.dailyStats[today].requestCount += 1;
    data.dailyStats[today].models[model] = (data.dailyStats[today].models[model] || 0) + inputTokens + outputTokens;

    // Thêm vào recent records (giữ tối đa 100 records)
    data.recentRecords.push(record);
    if (data.recentRecords.length > 100) {
        data.recentRecords = data.recentRecords.slice(-100);
    }

    // Lưu xuống file
    savePersistentData(data);

    // Cũng record vào global tracker
    const tracker = getGlobalTracker();
    tracker.recordUsage(model, inputTokens, outputTokens, requestId);

    return {
        record,
        dailyTotal: {
            inputTokens: data.dailyStats[today].inputTokens,
            outputTokens: data.dailyStats[today].outputTokens,
            totalTokens: data.dailyStats[today].totalTokens,
            cost: data.dailyStats[today].cost,
        },
        allTimeTotal: {
            inputTokens: data.totalStats.totalInputTokens,
            outputTokens: data.totalStats.totalOutputTokens,
            totalTokens: data.totalStats.totalTokens,
            cost: data.totalStats.totalCost,
        },
    };
}

/**
 * Lấy thống kê theo ngày
 */
export function getDailyStats(date?: string): {
    date: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cost: number;
    requestCount: number;
    models: Record<string, number>;
} | null {
    const data = loadPersistentData();
    const targetDate = date || new Date().toISOString().split('T')[0];
    return data.dailyStats[targetDate] || null;
}

/**
 * Lấy thống kê tổng tất cả thời gian
 */
export function getTotalStats(): {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
    totalCost: number;
    requestCount: number;
    lastUpdated: string;
} {
    const data = loadPersistentData();
    return {
        ...data.totalStats,
        lastUpdated: data.lastUpdated,
    };
}

/**
 * Lấy lịch sử sử dụng gần đây
 */
export function getUsageHistory(limit?: number): UsageRecord[] {
    const data = loadPersistentData();
    if (limit) {
        return data.recentRecords.slice(-limit);
    }
    return data.recentRecords;
}

/**
 * Lấy thống kê theo khoảng thời gian
 */
export function getStatsInRange(startDate: string, endDate: string): {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cost: number;
    requestCount: number;
    days: number;
    dailyBreakdown: Array<{ date: string; tokens: number; cost: number }>;
} {
    const data = loadPersistentData();
    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    let cost = 0;
    let requestCount = 0;
    const dailyBreakdown: Array<{ date: string; tokens: number; cost: number }> = [];

    for (const [date, stats] of Object.entries(data.dailyStats)) {
        if (date >= startDate && date <= endDate) {
            inputTokens += stats.inputTokens;
            outputTokens += stats.outputTokens;
            totalTokens += stats.totalTokens;
            cost += stats.cost;
            requestCount += stats.requestCount;
            dailyBreakdown.push({
                date,
                tokens: stats.totalTokens,
                cost: stats.cost,
            });
        }
    }

    // Sắp xếp theo ngày
    dailyBreakdown.sort((a, b) => a.date.localeCompare(b.date));

    return {
        inputTokens,
        outputTokens,
        totalTokens,
        cost,
        requestCount,
        days: dailyBreakdown.length,
        dailyBreakdown,
    };
}

/**
 * Reset persistent data (xóa tất cả lịch sử)
 */
export function resetPersistentData(): void {
    savePersistentData(createDefaultPersistentData());
}

/**
 * Export type cho external use
 */
export type { PersistentData };
