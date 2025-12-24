/**
 * Test đếm token cho cuộc hội thoại hiện tại
 */

import { countTokens } from './tokenCounter.js';
import { calculateCost } from './costCalculator.js';
import * as fs from 'fs';

const output: string[] = [];
function log(msg: string = '') {
    output.push(msg);
    console.log(msg);
}

// Nội dung User Request
const userRequest = `test lại dự án mcp này với chat này sao cho trả cho mình kết quả là chat này xài hết bao nhiêu token`;

// Đếm token cho user input
const userTokens = countTokens(userRequest, 'claude-3.5-sonnet');

console.log('');
console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║     🔮 MCP TokenSage - Phân Tích Token Cuộc Hội Thoại       ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log('');

console.log('📝 USER REQUEST:');
console.log(`   "${userRequest}"`);
console.log(`   → Token count: ${userTokens.tokenCount} tokens`);
console.log(`   → Model: ${userTokens.model}`);
console.log(`   → Encoding: ${userTokens.encoding}`);
console.log('');

console.log('═══════════════════════════════════════════════════════════════');
console.log('📊 ƯỚC TÍNH TOKEN CHO CUỘC HỘI THOẠI NÀY:');
console.log('═══════════════════════════════════════════════════════════════');
console.log('');

// Ước tính các thành phần
const systemPrompt = 12000;  // System prompt, tools definitions, user rules
const conversationHistory = 6000;  // 20 conversation summaries từ history
const additionalMetadata = 1500;  // File contents, directory listings, etc.
const userRequestTokens = userTokens.tokenCount;

const totalInputTokens = systemPrompt + conversationHistory + additionalMetadata + userRequestTokens;

console.log('📥 INPUT TOKENS (gửi đến AI):');
console.log(`   ├─ System Prompt + Tools:      ~${systemPrompt.toLocaleString()} tokens`);
console.log(`   ├─ Conversation History:       ~${conversationHistory.toLocaleString()} tokens`);
console.log(`   ├─ Additional Metadata:        ~${additionalMetadata.toLocaleString()} tokens`);
console.log(`   └─ User Request:                    ${userRequestTokens} tokens`);
console.log(`   ─────────────────────────────────────────`);
console.log(`   📥 TỔNG INPUT:                 ~${totalInputTokens.toLocaleString()} tokens`);
console.log('');

// Ước tính output (response của AI)
const estimatedOutputTokens = 2500; // Response bao gồm code, giải thích

console.log('📤 OUTPUT TOKENS (AI trả về):');
console.log(`   └─ Response (ước tính):        ~${estimatedOutputTokens.toLocaleString()} tokens`);
console.log('');

// Tổng tokens
const totalTokens = totalInputTokens + estimatedOutputTokens;
console.log('═══════════════════════════════════════════════════════════════');
console.log(`🔢 TỔNG TOKENS CHO CHAT NÀY:      ~${totalTokens.toLocaleString()} tokens`);
console.log('═══════════════════════════════════════════════════════════════');
console.log('');

// Tính chi phí cho nhiều models
console.log('💰 CHI PHÍ ƯỚC TÍNH:');
console.log('───────────────────────────────────────────────────────────────');

const models = [
    'claude-3.5-sonnet',
    'gpt-4o',
    'gpt-4o-mini',
    'gemini-1.5-pro',
    'gemini-1.5-flash',
    'deepseek-v3'
];

models.forEach(model => {
    const cost = calculateCost(model, totalInputTokens, estimatedOutputTokens);
    console.log(`   ${model.padEnd(20)} → $${cost.totalCost.toFixed(6)}`);
});

console.log('');
console.log('═══════════════════════════════════════════════════════════════');
console.log('');

// Chi tiết cho Claude 3.5 Sonnet (model đang dùng)
const claudeCost = calculateCost('claude-3.5-sonnet', totalInputTokens, estimatedOutputTokens);
console.log('📋 CHI TIẾT CHO CLAUDE 3.5 SONNET (đang sử dụng):');
console.log('───────────────────────────────────────────────────────────────');
console.log(`   ├─ Input cost:   ${totalInputTokens.toLocaleString()} tokens × $3/1M = $${claudeCost.inputCost.toFixed(6)}`);
console.log(`   ├─ Output cost:  ${estimatedOutputTokens.toLocaleString()} tokens × $15/1M = $${claudeCost.outputCost.toFixed(6)}`);
console.log(`   └─ TỔNG CHI PHÍ: $${claudeCost.totalCost.toFixed(6)}`);
console.log('');
console.log('✅ Test hoàn thành!');
console.log('');
