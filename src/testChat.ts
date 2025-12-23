/**
 * Test MCP TokenSage với nội dung chat thực tế
 */
import { countTokens, countTokensBatch } from './tokenCounter.js';
import { calculateCost } from './costCalculator.js';

// Đoạn chat mẫu từ cuộc hội thoại
const chatMessages = [
    "test lại hết tính năng của tool này",
    "Tôi sẽ giúp bạn test lại tất cả tính năng của tool MCP_TokenSage. Trước tiên, hãy để tôi xem cấu trúc dự án và các file quan trọng.",
    "Tuyệt vời! Tất cả 36 tests đều pass. Bây giờ tôi sẽ chạy file test.ts để kiểm tra các tính năng thực tế.",
    "thử test mcp để tính token cho chat này"
];

console.log('=== Test Token Count cho cuộc Chat ===\n');

// Test từng message
chatMessages.forEach((msg, i) => {
    const result = countTokens(msg, 'gpt-4o');
    console.log(`Message ${i + 1}: "${msg.substring(0, 50)}..."`);
    console.log(`  → Tokens: ${result.tokenCount} (encoding: ${result.encoding})\n`);
});

// Test batch
const batchResult = countTokensBatch(chatMessages, 'gpt-4o');
console.log('=== Tổng kết Batch ===');
console.log(`Tổng số messages: ${batchResult.results.length}`);
console.log(`Tổng tokens: ${batchResult.totalTokens}`);

// Tính chi phí cho các model phổ biến
console.log('\n=== Ước tính chi phí cho cuộc chat này ===');

const inputTokens = batchResult.totalTokens;
const outputTokens = Math.round(inputTokens * 1.5); // Giả định output gấp 1.5 lần input

const models = ['gpt-4o', 'gpt-4o-mini', 'claude-3.5-sonnet', 'gemini-1.5-pro'];

models.forEach(model => {
    try {
        const cost = calculateCost(model, inputTokens, outputTokens);
        console.log(`${model}: $${cost.totalCost.toFixed(6)} (in: $${cost.inputCost.toFixed(6)}, out: $${cost.outputCost.toFixed(6)})`);
    } catch (e) {
        console.log(`${model}: Không hỗ trợ`);
    }
});

console.log('\n✅ Test hoàn thành!');
