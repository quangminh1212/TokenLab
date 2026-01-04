#!/usr/bin/env node
/**
 * TokenSage Proxy Server
 * Intercept API requests to LLM providers and automatically track token usage
 * 
 * Usage:
 *   1. Start proxy: npm run proxy
 *   2. Configure your IDE to use http://localhost:4000 as the API base URL
 *   3. All requests will be logged with token usage and costs
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';
import { recordUsagePersistent, getDailyStats, getTotalStats, getUsageHistory } from './usageTracker.js';
import { calculateCost } from './costCalculator.js';
import { getDashboardHTML } from './dashboard.js';
import { PROXY, PROVIDER_PATTERNS } from './config.js';
import { estimateTokens } from './tokenCounter.js';
import type { ProviderName } from './types.js';

// Configuration
const PROXY_PORT = parseInt(process.env.PROXY_PORT || String(PROXY.DEFAULT_PORT));
const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT || String(PROXY.DEFAULT_DASHBOARD_PORT));

// Supported LLM API endpoints
const API_ENDPOINTS: Record<string, { host: string; basePath: string }> = {
    openai: { host: 'api.openai.com', basePath: '/v1' },
    anthropic: { host: 'api.anthropic.com', basePath: '/v1' },
    google: { host: 'generativelanguage.googleapis.com', basePath: '/v1' },
};

// Request/Response types
interface ProxyRequest {
    id: string;
    timestamp: Date;
    provider: string;
    endpoint: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cost: number;
    latencyMs: number;
    status: number;
}

// In-memory request log (recent requests)
const recentRequests: ProxyRequest[] = [];

// Generate unique request ID
function generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

// Detect provider from host patterns
function detectProviderFromHost(host: string): ProviderName {
    const hostLower = host.toLowerCase();
    
    // Special case: azure openai
    if (hostLower.includes('azure') && hostLower.includes('openai')) {
        return 'azure';
    }
    // Special case: exclude azure from openai
    if (hostLower.includes('openai') && !hostLower.includes('azure')) {
        return 'openai';
    }
    
    for (const [provider, patterns] of Object.entries(PROVIDER_PATTERNS)) {
        if (provider === 'openai') continue; // Already handled above
        if (patterns.some(pattern => hostLower.includes(pattern))) {
            return provider as ProviderName;
        }
    }
    return 'unknown';
}

// Detect provider from request
function detectProvider(host: string, path: string): ProviderName {
    // First try host-based detection
    const hostProvider = detectProviderFromHost(host);
    if (hostProvider !== 'unknown') {
        return hostProvider;
    }
    
    // Fallback to path-based detection
    if (path.startsWith('/v1/chat/completions') || path.startsWith('/v1/completions')) {
        return 'openai';
    }
    if (path.startsWith('/v1/messages')) {
        return 'anthropic';
    }
    if (path.includes('generateContent')) {
        return 'google';
    }
    return 'unknown';
}

// Extract model from request body
function extractModelFromRequest(body: string, provider: string): string {
    try {
        const json = JSON.parse(body);
        if (provider === 'openai') {
            return json.model || 'gpt-4';
        }
        if (provider === 'anthropic') {
            return json.model || 'claude-3-sonnet-20240229';
        }
        if (provider === 'google') {
            return json.model || 'gemini-1.5-flash';
        }
        return json.model || 'unknown';
    } catch {
        return 'unknown';
    }
}

// Extract token usage from response
interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    model: string;
}

function extractTokenUsage(body: string, provider: string, requestModel: string, requestBody?: string): TokenUsage {
    try {
        const json = JSON.parse(body);

        // OpenAI format
        if (provider === 'openai' || json.usage?.prompt_tokens !== undefined) {
            const usage = json.usage || {};
            if (usage.prompt_tokens || usage.completion_tokens) {
                return {
                    inputTokens: usage.prompt_tokens || 0,
                    outputTokens: usage.completion_tokens || 0,
                    totalTokens: usage.total_tokens || 0,
                    model: json.model || requestModel,
                };
            }
        }

        // Anthropic format
        if (provider === 'anthropic' || json.usage?.input_tokens !== undefined) {
            const usage = json.usage || {};
            if (usage.input_tokens || usage.output_tokens) {
                const inputTokens = usage.input_tokens || 0;
                const outputTokens = usage.output_tokens || 0;
                return {
                    inputTokens,
                    outputTokens,
                    totalTokens: inputTokens + outputTokens,
                    model: json.model || requestModel,
                };
            }
        }

        // Google format
        if (provider === 'google' || json.usageMetadata) {
            const usage = json.usageMetadata || {};
            if (usage.promptTokenCount || usage.candidatesTokenCount) {
                return {
                    inputTokens: usage.promptTokenCount || 0,
                    outputTokens: usage.candidatesTokenCount || 0,
                    totalTokens: usage.totalTokenCount || 0,
                    model: requestModel,
                };
            }
        }

        // Fallback: Estimate tokens from content if no usage info
        let estimatedInput = 0;
        let estimatedOutput = 0;

        // Estimate input from request body
        if (requestBody) {
            try {
                const reqJson = JSON.parse(requestBody);
                if (reqJson.messages) {
                    const inputText = reqJson.messages.map((m: { content?: string }) => m.content || '').join(' ');
                    estimatedInput = estimateTokens(inputText);
                } else if (reqJson.prompt) {
                    estimatedInput = estimateTokens(reqJson.prompt);
                }
            } catch {
                estimatedInput = estimateTokens(requestBody);
            }
        }

        // Estimate output from response
        if (json.choices?.[0]?.message?.content) {
            estimatedOutput = estimateTokens(json.choices[0].message.content);
        } else if (json.choices?.[0]?.text) {
            estimatedOutput = estimateTokens(json.choices[0].text);
        } else if (json.content?.[0]?.text) {
            estimatedOutput = estimateTokens(json.content[0].text);
        } else if (json.candidates?.[0]?.content?.parts?.[0]?.text) {
            estimatedOutput = estimateTokens(json.candidates[0].content.parts[0].text);
        }

        if (estimatedInput > 0 || estimatedOutput > 0) {
            return {
                inputTokens: estimatedInput,
                outputTokens: estimatedOutput,
                totalTokens: estimatedInput + estimatedOutput,
                model: json.model || requestModel,
            };
        }

        return { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: requestModel };
    } catch {
        // If response is not JSON, try to estimate from raw text
        if (requestBody) {
            const estimatedInput = estimateTokens(requestBody);
            const estimatedOutput = estimateTokens(body);
            if (estimatedInput > 0 || estimatedOutput > 0) {
                return {
                    inputTokens: estimatedInput,
                    outputTokens: estimatedOutput,
                    totalTokens: estimatedInput + estimatedOutput,
                    model: requestModel,
                };
            }
        }
        return { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: requestModel };
    }
}


// Forward request to the target API
function forwardRequest(
    targetHost: string,
    targetPath: string,
    method: string,
    headers: http.IncomingHttpHeaders,
    body: string,
    _provider: string,
    requestId: string
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
        const startTime = Date.now();

        const targetHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(headers)) {
            if (key.toLowerCase() !== 'host' && key.toLowerCase() !== 'content-length') {
                targetHeaders[key] = Array.isArray(value) ? value.join(', ') : (value || '');
            }
        }
        targetHeaders['host'] = targetHost;
        if (body) {
            targetHeaders['content-length'] = Buffer.byteLength(body).toString();
        }

        const options: https.RequestOptions = {
            hostname: targetHost,
            port: 443,
            path: targetPath,
            method,
            headers: targetHeaders,
        };

        const req = https.request(options, (res) => {
            const chunks: Buffer[] = [];

            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const responseBody = Buffer.concat(chunks).toString();
                const latencyMs = Date.now() - startTime;

                console.log(`[${requestId}] ${method} ${targetPath} -> ${res.statusCode} (${latencyMs}ms)`);

                resolve({
                    statusCode: res.statusCode || 500,
                    headers: res.headers,
                    body: responseBody,
                });
            });
        });

        req.on('error', (error) => {
            console.error(`[${requestId}] Request error:`, error.message);
            reject(error);
        });

        if (body) {
            req.write(body);
        }
        req.end();
    });
}

// Handle streaming response (SSE)
function handleStreamingRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    targetHost: string,
    targetPath: string,
    headers: http.IncomingHttpHeaders,
    body: string,
    provider: string,
    requestId: string,
    requestModel: string
): void {
    const startTime = Date.now();

    const targetHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() !== 'host' && key.toLowerCase() !== 'content-length') {
            targetHeaders[key] = Array.isArray(value) ? value.join(', ') : (value || '');
        }
    }
    targetHeaders['host'] = targetHost;
    if (body) {
        targetHeaders['content-length'] = Buffer.byteLength(body).toString();
    }

    const options: https.RequestOptions = {
        hostname: targetHost,
        port: 443,
        path: targetPath,
        method: req.method,
        headers: targetHeaders,
    };

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let streamBuffer = '';
    let fullResponseContent = ''; // Collect full response for estimation

    // Estimate input tokens from request
    let estimatedInputTokens = 0;
    try {
        const reqJson = JSON.parse(body);
        if (reqJson.messages) {
            const inputText = reqJson.messages.map((m: { content?: string }) => m.content || '').join(' ');
            estimatedInputTokens = estimateTokens(inputText);
        } else if (reqJson.prompt) {
            estimatedInputTokens = estimateTokens(reqJson.prompt);
        }
    } catch {
        estimatedInputTokens = estimateTokens(body);
    }

    const proxyReq = https.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);

        proxyRes.on('data', (chunk: Buffer) => {
            res.write(chunk);
            streamBuffer += chunk.toString();

            const lines = streamBuffer.split('\n');
            streamBuffer = lines.pop() || '';

            for (const line of lines) {
                if (line.startsWith('data: ') && !line.includes('[DONE]')) {
                    try {
                        const data = JSON.parse(line.substring(6));
                        // Collect content for estimation
                        if (data.choices?.[0]?.delta?.content) {
                            fullResponseContent += data.choices[0].delta.content;
                        }
                        if (data.delta?.text) {
                            fullResponseContent += data.delta.text;
                        }
                        if (data.content_block?.text) {
                            fullResponseContent += data.content_block.text;
                        }
                        // Check for usage info
                        if (data.usage) {
                            totalInputTokens = data.usage.prompt_tokens || data.usage.input_tokens || 0;
                            totalOutputTokens = data.usage.completion_tokens || data.usage.output_tokens || 0;
                        }
                        if (data.message?.usage) {
                            totalInputTokens = data.message.usage.input_tokens || 0;
                            totalOutputTokens = data.message.usage.output_tokens || 0;
                        }
                    } catch {
                        // Ignore parse errors in stream
                    }
                }
            }
        });

        proxyRes.on('end', () => {
            res.end();
            const latencyMs = Date.now() - startTime;

            // Use API-provided tokens if available, otherwise estimate
            let finalInputTokens = totalInputTokens;
            let finalOutputTokens = totalOutputTokens;

            if (finalInputTokens === 0 && finalOutputTokens === 0) {
                // Estimate from collected content
                finalInputTokens = estimatedInputTokens;
                finalOutputTokens = fullResponseContent ? estimateTokens(fullResponseContent) : 0;
            }

            if (finalInputTokens > 0 || finalOutputTokens > 0) {
                const costResult = calculateCost(requestModel, finalInputTokens, finalOutputTokens);
                const cost = costResult.totalCost;

                recordUsagePersistent(requestModel, finalInputTokens, finalOutputTokens, cost, requestId);

                const proxyRequest: ProxyRequest = {
                    id: requestId,
                    timestamp: new Date(),
                    provider,
                    endpoint: targetPath,
                    model: requestModel,
                    inputTokens: finalInputTokens,
                    outputTokens: finalOutputTokens,
                    totalTokens: finalInputTokens + finalOutputTokens,
                    cost,
                    latencyMs,
                    status: proxyRes.statusCode || 200,
                };
                recentRequests.unshift(proxyRequest);
                if (recentRequests.length > PROXY.MAX_RECENT_REQUESTS) {
                    recentRequests.pop();
                }

                const estimated = (totalInputTokens === 0 && totalOutputTokens === 0) ? ' (estimated)' : '';
                console.log(`[${requestId}] STREAM: ${requestModel} | ${finalInputTokens}+${finalOutputTokens} tokens${estimated} | $${cost.toFixed(6)} | ${latencyMs}ms`);
            }
        });
    });

    proxyReq.on('error', (error) => {
        console.error(`[${requestId}] Stream error:`, error.message);
        if (!res.headersSent) {
            res.writeHead(502);
        }
        res.end(`Proxy error: ${error.message}`);
    });

    if (body) {
        proxyReq.write(body);
    }
    proxyReq.end();
}


// Create the proxy server
const proxyServer = http.createServer(async (req, res) => {
    const requestId = generateRequestId();
    const startTime = Date.now();

    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));

    req.on('end', async () => {
        const body = Buffer.concat(chunks).toString();
        const url = new URL(req.url || '/', `http://${req.headers.host}`);

        // Check for dashboard/stats endpoints
        if (url.pathname === '/stats' || url.pathname === '/tokensage/stats') {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({
                daily: getDailyStats(),
                total: getTotalStats(),
                recentRequests: recentRequests.slice(0, 20),
            }, null, 2));
            return;
        }

        if (url.pathname === '/history' || url.pathname === '/tokensage/history') {
            const limit = parseInt(url.searchParams.get('limit') || '50');
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify(getUsageHistory(limit), null, 2));
            return;
        }

        if (url.pathname === '/health' || url.pathname === '/tokensage/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
            return;
        }

        // API endpoint to receive data from mitmproxy
        if (url.pathname === '/ingest' || url.pathname === '/tokensage/ingest') {
            if (req.method === 'POST') {
                try {
                    const data = JSON.parse(body);
                    const { model, input_tokens, output_tokens, host, path: reqPath, request_id } = data;
                    
                    if (input_tokens > 0 || output_tokens > 0) {
                        const costResult = calculateCost(model || 'unknown', input_tokens || 0, output_tokens || 0);
                        const cost = costResult.totalCost;
                        
                        recordUsagePersistent(
                            model || 'unknown',
                            input_tokens || 0,
                            output_tokens || 0,
                            cost,
                            request_id || `mitm_${Date.now()}`
                        );

                        // Add to recent requests for dashboard
                        const proxyRequest: ProxyRequest = {
                            id: request_id || `mitm_${Date.now()}`,
                            timestamp: new Date(),
                            provider: detectProviderFromHost(host || ''),
                            endpoint: reqPath || '/',
                            model: model || 'unknown',
                            inputTokens: input_tokens || 0,
                            outputTokens: output_tokens || 0,
                            totalTokens: (input_tokens || 0) + (output_tokens || 0),
                            cost,
                            latencyMs: data.latency_ms || 0,
                            status: data.status_code || 200,
                        };
                        recentRequests.unshift(proxyRequest);
                        if (recentRequests.length > PROXY.MAX_RECENT_REQUESTS) {
                            recentRequests.pop();
                        }

                        console.log(`[MITM] ${model} | ${input_tokens}+${output_tokens} tokens | ${cost.toFixed(6)}`);
                        
                        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                        res.end(JSON.stringify({ success: true, cost: costResult }));
                        return;
                    }
                    
                    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify({ success: true, message: 'No tokens to record' }));
                    return;
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify({ error: 'Invalid JSON', message: (e as Error).message }));
                    return;
                }
            }
        }

        // Handle CORS preflight
        if (req.method === 'OPTIONS') {
            res.writeHead(200, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
                'Access-Control-Allow-Headers': '*',
            });
            res.end();
            return;
        }

        // Determine target host from request headers or path
        let targetHost = req.headers['x-target-host'] as string || '';
        const targetPath = url.pathname + url.search;

        const hostHeader = req.headers.host || '';
        let provider = detectProvider(targetHost || hostHeader, targetPath);

        if (!targetHost) {
            if (targetPath.startsWith('/v1/chat/completions') || targetPath.startsWith('/v1/completions')) {
                targetHost = API_ENDPOINTS.openai.host;
                provider = 'openai';
            } else if (targetPath.startsWith('/v1/messages')) {
                targetHost = API_ENDPOINTS.anthropic.host;
                provider = 'anthropic';
            } else {
                targetHost = API_ENDPOINTS.openai.host;
                provider = 'openai';
            }
        }

        if (!provider) {
            provider = 'unknown';
        }

        const requestModel = extractModelFromRequest(body, provider);
        const isStreaming = body.includes('"stream":true') || body.includes('"stream": true');

        if (isStreaming) {
            handleStreamingRequest(req, res, targetHost, targetPath, req.headers, body, provider, requestId, requestModel);
            return;
        }

        try {
            const response = await forwardRequest(targetHost, targetPath, req.method || 'GET', req.headers, body, provider, requestId);
            const latencyMs = Date.now() - startTime;

            const tokenUsage = extractTokenUsage(response.body, provider, requestModel, body);

            if (tokenUsage.totalTokens > 0) {
                const costResult = calculateCost(tokenUsage.model, tokenUsage.inputTokens, tokenUsage.outputTokens);
                const cost = costResult.totalCost;

                recordUsagePersistent(tokenUsage.model, tokenUsage.inputTokens, tokenUsage.outputTokens, cost, requestId);

                const proxyRequest: ProxyRequest = {
                    id: requestId,
                    timestamp: new Date(),
                    provider,
                    endpoint: targetPath,
                    model: tokenUsage.model,
                    inputTokens: tokenUsage.inputTokens,
                    outputTokens: tokenUsage.outputTokens,
                    totalTokens: tokenUsage.totalTokens,
                    cost,
                    latencyMs,
                    status: response.statusCode,
                };
                recentRequests.unshift(proxyRequest);
                if (recentRequests.length > PROXY.MAX_RECENT_REQUESTS) {
                    recentRequests.pop();
                }

                console.log(`[${requestId}] ${tokenUsage.model} | ${tokenUsage.inputTokens}+${tokenUsage.outputTokens} tokens | $${cost.toFixed(6)} | ${latencyMs}ms`);
            }

            const responseHeaders: Record<string, string> = { 'Access-Control-Allow-Origin': '*' };
            for (const [key, value] of Object.entries(response.headers)) {
                if (value && !['transfer-encoding'].includes(key.toLowerCase())) {
                    responseHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
                }
            }

            res.writeHead(response.statusCode, responseHeaders);
            res.end(response.body);

        } catch (error) {
            console.error(`[${requestId}] Error:`, error);
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Proxy error', message: (error as Error).message }));
        }
    });
});


// Dashboard server
const dashboardServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(getDashboardHTML(PROXY_PORT));
});

// Start servers
function startProxy(): void {
    proxyServer.listen(PROXY_PORT, () => {
        console.log('');
        console.log('========================================================');
        console.log('           TokenSage Proxy Server Started               ');
        console.log('========================================================');
        console.log(`  Proxy URL:     http://localhost:${PROXY_PORT}`);
        console.log(`  Dashboard:     http://localhost:${DASHBOARD_PORT}`);
        console.log('--------------------------------------------------------');
        console.log('  Stats API:     /stats, /history');
        console.log('--------------------------------------------------------');
        console.log('  Configure your IDE to use the proxy URL:');
        console.log('');
        console.log('  Cursor/Windsurf:');
        console.log(`    Set OPENAI_BASE_URL=http://localhost:${PROXY_PORT}/v1`);
        console.log('');
        console.log('  Or use x-target-host header to specify target');
        console.log('========================================================');
        console.log('');
    });

    dashboardServer.listen(DASHBOARD_PORT, () => {
        console.log(`Dashboard running at http://localhost:${DASHBOARD_PORT}`);
    });
}

// Export for programmatic use
export { startProxy, proxyServer, dashboardServer };

// Start if run directly
startProxy();
