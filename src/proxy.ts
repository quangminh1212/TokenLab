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
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { recordUsagePersistent, getDailyStats, getTotalStats, getUsageHistory } from './usageTracker.js';
import { calculateCost } from './costCalculator.js';
import { getDashboardHTML } from './dashboard.js';

// Settings path
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SETTINGS_FILE = path.join(__dirname, '..', 'data', 'settings.json');

// Settings interface
interface TrackingAppConfig {
    enabled: boolean;
    name: string;
    icon: string;
}

interface Settings {
    enabled: boolean;
    autoRefresh: boolean;
    refreshInterval: number;
    trackingApps: Record<string, TrackingAppConfig>;
}

// Load settings
function loadSettings(): Settings {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
        }
    } catch (error) {
        console.error('Error loading settings:', error);
    }
    // Default settings
    return {
        enabled: true,
        autoRefresh: true,
        refreshInterval: 5000,
        trackingApps: {
            antigravity: { enabled: true, name: 'Antigravity (Google)', icon: '🌀' },
            cursor: { enabled: true, name: 'Cursor', icon: '🔮' },
            windsurf: { enabled: true, name: 'Windsurf', icon: '🏄' },
            kiro: { enabled: true, name: 'Kiro (AWS)', icon: '🔷' },
            copilot: { enabled: true, name: 'GitHub Copilot', icon: '🐙' },
            openai: { enabled: true, name: 'OpenAI', icon: '🤖' },
            anthropic: { enabled: true, name: 'Anthropic', icon: '🔶' },
            google: { enabled: true, name: 'Google/Gemini', icon: '✨' },
            aws: { enabled: true, name: 'AWS Bedrock', icon: '☁️' },
            azure: { enabled: true, name: 'Azure OpenAI', icon: '💎' },
            deepseek: { enabled: true, name: 'DeepSeek', icon: '🔍' },
            groq: { enabled: true, name: 'Groq', icon: '⚡' },
            mistral: { enabled: true, name: 'Mistral', icon: '💨' },
            together: { enabled: true, name: 'Together AI', icon: '🤝' },
            perplexity: { enabled: true, name: 'Perplexity', icon: '🔮' },
            cohere: { enabled: true, name: 'Cohere', icon: '🎯' },
            replicate: { enabled: true, name: 'Replicate', icon: '🔄' },
        }
    };
}

// Save settings
function saveSettings(settings: Settings): void {
    try {
        const dir = path.dirname(SETTINGS_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
    } catch (error) {
        console.error('Error saving settings:', error);
    }
}

// Check if provider should be tracked
function shouldTrackProvider(provider: string): boolean {
    const settings = loadSettings();
    if (!settings.enabled) return false;
    const appConfig = settings.trackingApps[provider];
    return appConfig ? appConfig.enabled : true; // Default to enabled for unknown providers
}

// Configuration
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '4000');
const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT || '4001');

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

// In-memory request log (recent 100 requests)
const recentRequests: ProxyRequest[] = [];
const MAX_RECENT_REQUESTS = 100;

// Generate unique request ID
function generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

// Detect provider from request
function detectProvider(host: string, path: string): string | null {
    if (host.includes('openai') || path.startsWith('/v1/chat/completions') || path.startsWith('/v1/completions')) {
        return 'openai';
    }
    if (host.includes('anthropic') || path.startsWith('/v1/messages')) {
        return 'anthropic';
    }
    if (host.includes('google') || host.includes('generativelanguage') || path.includes('generateContent')) {
        return 'google';
    }
    return null;
}

// Detect provider from host only (for mitmproxy data)
function detectProviderFromHost(host: string): string {
    const h = host.toLowerCase();

    // AI IDEs
    if (h.includes('antigravity.google') || h.includes('antigravity')) return 'antigravity';
    if (h.includes('cursor')) return 'cursor';
    if (h.includes('codeium') || h.includes('windsurf')) return 'windsurf';
    if (h.includes('kiro')) return 'kiro';
    if (h.includes('zed.dev')) return 'zed';
    if (h.includes('tabnine')) return 'tabnine';
    if (h.includes('sourcegraph') || h.includes('cody')) return 'cody';
    if (h.includes('jetbrains') && h.includes('ai')) return 'jetbrains';
    if (h.includes('replit')) return 'replit';
    if (h.includes('continue.dev')) return 'continue';

    // Major LLM Providers
    if (h.includes('openai') && !h.includes('azure')) return 'openai';
    if (h.includes('anthropic') || h.includes('claude.ai')) return 'anthropic';
    if (h.includes('google') || h.includes('generativelanguage') || h.includes('gemini') || h.includes('aistudio')) return 'google';
    if (h.includes('copilot') || h.includes('githubcopilot')) return 'copilot';
    if (h.includes('bedrock') || h.includes('codewhisperer') || h.includes('q.us-')) return 'aws';
    if (h.includes('azure') && (h.includes('openai') || h.includes('cognitive'))) return 'azure';

    // Other LLM Providers
    if (h.includes('mistral')) return 'mistral';
    if (h.includes('cohere')) return 'cohere';
    if (h.includes('deepseek')) return 'deepseek';
    if (h.includes('together')) return 'together';
    if (h.includes('groq')) return 'groq';
    if (h.includes('perplexity')) return 'perplexity';
    if (h.includes('replicate')) return 'replicate';
    if (h.includes('fireworks')) return 'fireworks';
    if (h.includes('anyscale')) return 'anyscale';
    if (h.includes('huggingface')) return 'huggingface';
    if (h.includes('cerebras')) return 'cerebras';
    if (h.includes('sambanova')) return 'sambanova';
    if (h.includes('ai21')) return 'ai21';
    if (h.includes('aleph-alpha')) return 'aleph-alpha';
    if (h.includes('nlpcloud')) return 'nlpcloud';
    if (h.includes('lepton')) return 'lepton';
    if (h.includes('modal')) return 'modal';
    if (h.includes('runpod')) return 'runpod';
    if (h.includes('baseten')) return 'baseten';
    if (h.includes('banana')) return 'banana';
    if (h.includes('octoai')) return 'octoai';
    if (h.includes('lambdalabs')) return 'lambdalabs';
    if (h.includes('moonshot')) return 'moonshot';
    if (h.includes('baichuan')) return 'baichuan';
    if (h.includes('zhipuai')) return 'zhipuai';
    if (h.includes('minimax')) return 'minimax';
    if (h.includes('x.ai') || h.includes('xai')) return 'xai';
    if (h.includes('ollama') || h.includes('localhost:11434') || h.includes('127.0.0.1:11434')) return 'ollama';
    if (h.includes('lmstudio') || h.includes('localhost:1234') || h.includes('127.0.0.1:1234')) return 'lmstudio';

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

function extractTokenUsage(body: string, provider: string, requestModel: string): TokenUsage {
    try {
        const json = JSON.parse(body);

        if (provider === 'openai') {
            const usage = json.usage || {};
            return {
                inputTokens: usage.prompt_tokens || 0,
                outputTokens: usage.completion_tokens || 0,
                totalTokens: usage.total_tokens || 0,
                model: json.model || requestModel,
            };
        }

        if (provider === 'anthropic') {
            const usage = json.usage || {};
            const inputTokens = usage.input_tokens || 0;
            const outputTokens = usage.output_tokens || 0;
            return {
                inputTokens,
                outputTokens,
                totalTokens: inputTokens + outputTokens,
                model: json.model || requestModel,
            };
        }

        if (provider === 'google') {
            const usage = json.usageMetadata || {};
            return {
                inputTokens: usage.promptTokenCount || 0,
                outputTokens: usage.candidatesTokenCount || 0,
                totalTokens: usage.totalTokenCount || 0,
                model: requestModel,
            };
        }

        return { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: requestModel };
    } catch {
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
                        if (data.usage) {
                            totalInputTokens = data.usage.prompt_tokens || 0;
                            totalOutputTokens = data.usage.completion_tokens || 0;
                        }
                        if (data.message?.usage) {
                            totalOutputTokens = data.message.usage.output_tokens || 0;
                        }
                        if (data.usage?.input_tokens) {
                            totalInputTokens = data.usage.input_tokens;
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

            if (totalInputTokens > 0 || totalOutputTokens > 0) {
                const costResult = calculateCost(requestModel, totalInputTokens, totalOutputTokens);
                const cost = costResult.totalCost;

                recordUsagePersistent(requestModel, totalInputTokens, totalOutputTokens, cost, requestId);

                const proxyRequest: ProxyRequest = {
                    id: requestId,
                    timestamp: new Date(),
                    provider,
                    endpoint: targetPath,
                    model: requestModel,
                    inputTokens: totalInputTokens,
                    outputTokens: totalOutputTokens,
                    totalTokens: totalInputTokens + totalOutputTokens,
                    cost,
                    latencyMs,
                    status: proxyRes.statusCode || 200,
                };
                recentRequests.unshift(proxyRequest);
                if (recentRequests.length > MAX_RECENT_REQUESTS) {
                    recentRequests.pop();
                }

                console.log(`[${requestId}] STREAM: ${requestModel} | ${totalInputTokens}+${totalOutputTokens} tokens | ${cost.toFixed(6)} | ${latencyMs}ms`);
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

                    // Check if provider should be tracked
                    const provider = detectProviderFromHost(host || '');
                    if (!shouldTrackProvider(provider)) {
                        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                        res.end(JSON.stringify({ success: true, message: `Tracking disabled for ${provider}`, skipped: true }));
                        return;
                    }

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
                            provider,
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
                        if (recentRequests.length > MAX_RECENT_REQUESTS) {
                            recentRequests.pop();
                        }

                        console.log(`[MITM] ${provider} | ${model} | ${input_tokens}+${output_tokens} tokens | ${cost.toFixed(6)}`);

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

        // Settings API endpoint
        if (url.pathname === '/settings' || url.pathname === '/tokensage/settings') {
            if (req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify(loadSettings(), null, 2));
                return;
            }
            if (req.method === 'POST') {
                try {
                    const newSettings = JSON.parse(body);
                    saveSettings(newSettings);
                    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify({ success: true, settings: loadSettings() }));
                    return;
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify({ error: 'Invalid JSON', message: (e as Error).message }));
                    return;
                }
            }
        }

        // Toggle app tracking endpoint
        if (url.pathname.startsWith('/settings/toggle/') || url.pathname.startsWith('/tokensage/settings/toggle/')) {
            const appName = url.pathname.split('/').pop();
            if (appName && req.method === 'POST') {
                const settings = loadSettings();
                if (settings.trackingApps[appName]) {
                    settings.trackingApps[appName].enabled = !settings.trackingApps[appName].enabled;
                    saveSettings(settings);
                    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify({
                        success: true,
                        app: appName,
                        enabled: settings.trackingApps[appName].enabled
                    }));
                    return;
                }
                res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: 'App not found', app: appName }));
                return;
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

            const tokenUsage = extractTokenUsage(response.body, provider, requestModel);

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
                if (recentRequests.length > MAX_RECENT_REQUESTS) {
                    recentRequests.pop();
                }

                console.log(`[${requestId}] ${tokenUsage.model} | ${tokenUsage.inputTokens}+${tokenUsage.outputTokens} tokens | ${cost.toFixed(6)} | ${latencyMs}ms`);
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
