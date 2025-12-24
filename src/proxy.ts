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
import { calculateCost, MODEL_PRICING } from './costCalculator.js';

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
            // Google includes model in URL, extract from path
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
            // OpenAI format: { usage: { prompt_tokens, completion_tokens, total_tokens } }
            const usage = json.usage || {};
            return {
                inputTokens: usage.prompt_tokens || 0,
                outputTokens: usage.completion_tokens || 0,
                totalTokens: usage.total_tokens || 0,
                model: json.model || requestModel,
            };
        }

        if (provider === 'anthropic') {
            // Anthropic format: { usage: { input_tokens, output_tokens } }
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
            // Google format: { usageMetadata: { promptTokenCount, candidatesTokenCount, totalTokenCount } }
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
    provider: string,
    requestId: string
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
        const startTime = Date.now();

        // Prepare headers for target
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

                // Log the request
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

    // Prepare headers
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
        // Forward headers
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);

        proxyRes.on('data', (chunk) => {
            res.write(chunk);
            streamBuffer += chunk.toString();

            // Parse SSE data to extract token usage
            const lines = streamBuffer.split('\n');
            streamBuffer = lines.pop() || '';

            for (const line of lines) {
                if (line.startsWith('data: ') && !line.includes('[DONE]')) {
                    try {
                        const data = JSON.parse(line.substring(6));
                        // OpenAI streaming includes usage in last chunk
                        if (data.usage) {
                            totalInputTokens = data.usage.prompt_tokens || 0;
                            totalOutputTokens = data.usage.completion_tokens || 0;
                        }
                        // Anthropic streaming format
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

            // Record usage if we have token data
            if (totalInputTokens > 0 || totalOutputTokens > 0) {
                const costResult = calculateCost(requestModel, totalInputTokens, totalOutputTokens);
                const cost = costResult.totalCost;

                recordUsagePersistent(
                    requestModel,
                    totalInputTokens,
                    totalOutputTokens,
                    cost,
                    requestId
                );

                // Add to recent requests
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

                console.log(`[${requestId}] STREAM: ${requestModel} | ${totalInputTokens}+${totalOutputTokens} tokens | $${cost.toFixed(6)} | ${latencyMs}ms`);
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

    // Collect request body
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
        let targetPath = url.pathname + url.search;

        // Auto-detect provider from host header or path
        const hostHeader = req.headers.host || '';
        let provider = detectProvider(targetHost || hostHeader, targetPath);

        // If target not specified, try to infer from path
        if (!targetHost) {
            if (targetPath.startsWith('/v1/chat/completions') || targetPath.startsWith('/v1/completions')) {
                targetHost = API_ENDPOINTS.openai.host;
                provider = 'openai';
            } else if (targetPath.startsWith('/v1/messages')) {
                targetHost = API_ENDPOINTS.anthropic.host;
                provider = 'anthropic';
            } else {
                // Default to OpenAI
                targetHost = API_ENDPOINTS.openai.host;
                provider = 'openai';
            }
        }

        if (!provider) {
            provider = 'unknown';
        }

        // Extract model from request
        const requestModel = extractModelFromRequest(body, provider);

        // Check if streaming request
        const isStreaming = body.includes('"stream":true') || body.includes('"stream": true');

        if (isStreaming) {
            handleStreamingRequest(
                req, res, targetHost, targetPath,
                req.headers, body, provider, requestId, requestModel
            );
            return;
        }

        try {
            // Forward non-streaming request
            const response = await forwardRequest(
                targetHost, targetPath,
                req.method || 'GET',
                req.headers, body,
                provider, requestId
            );

            const latencyMs = Date.now() - startTime;

            // Extract and record token usage
            const tokenUsage = extractTokenUsage(response.body, provider, requestModel);

            if (tokenUsage.totalTokens > 0) {
                const costResult = calculateCost(tokenUsage.model, tokenUsage.inputTokens, tokenUsage.outputTokens);
                const cost = costResult.totalCost;

                recordUsagePersistent(
                    tokenUsage.model,
                    tokenUsage.inputTokens,
                    tokenUsage.outputTokens,
                    cost,
                    requestId
                );

                // Add to recent requests
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

                console.log(`[${requestId}] ${tokenUsage.model} | ${tokenUsage.inputTokens}+${tokenUsage.outputTokens} tokens | $${cost.toFixed(6)} | ${latencyMs}ms`);
            }

            // Forward response headers and body
            const responseHeaders: Record<string, string> = {
                'Access-Control-Allow-Origin': '*',
            };
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

// Simple dashboard HTML
function getDashboardHTML(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TokenSage Dashboard</title>
    <style>
        :root {
            --bg-primary: #0f0f23;
            --bg-secondary: #1a1a2e;
            --bg-card: #16213e;
            --text-primary: #e4e4e7;
            --text-secondary: #a1a1aa;
            --accent: #00d9ff;
            --accent-green: #00ff88;
            --accent-orange: #ff9f43;
            --accent-purple: #a855f7;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: 'Segoe UI', system-ui, sans-serif;
            background: var(--bg-primary);
            color: var(--text-primary);
            min-height: 100vh;
            padding: 20px;
        }
        .container { max-width: 1400px; margin: 0 auto; }
        h1 {
            font-size: 2rem;
            background: linear-gradient(135deg, var(--accent), var(--accent-purple));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-bottom: 24px;
        }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 16px;
            margin-bottom: 24px;
        }
        .stat-card {
            background: var(--bg-card);
            border-radius: 12px;
            padding: 20px;
            border: 1px solid rgba(255,255,255,0.05);
        }
        .stat-label { color: var(--text-secondary); font-size: 0.875rem; margin-bottom: 8px; }
        .stat-value { font-size: 1.75rem; font-weight: 600; }
        .stat-value.tokens { color: var(--accent); }
        .stat-value.cost { color: var(--accent-green); }
        .stat-value.requests { color: var(--accent-orange); }
        .requests-table {
            background: var(--bg-card);
            border-radius: 12px;
            overflow: hidden;
            border: 1px solid rgba(255,255,255,0.05);
        }
        .table-header {
            padding: 16px 20px;
            border-bottom: 1px solid rgba(255,255,255,0.05);
            font-weight: 600;
        }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 12px 16px; text-align: left; }
        th { color: var(--text-secondary); font-weight: 500; font-size: 0.875rem; }
        td { border-top: 1px solid rgba(255,255,255,0.03); font-size: 0.875rem; }
        tr:hover { background: rgba(255,255,255,0.02); }
        .model-badge {
            display: inline-block;
            background: rgba(168,85,247,0.2);
            color: var(--accent-purple);
            padding: 4px 8px;
            border-radius: 6px;
            font-size: 0.75rem;
        }
        .provider-badge {
            display: inline-block;
            padding: 4px 8px;
            border-radius: 6px;
            font-size: 0.75rem;
        }
        .provider-openai { background: rgba(0,217,255,0.2); color: var(--accent); }
        .provider-anthropic { background: rgba(255,159,67,0.2); color: var(--accent-orange); }
        .provider-google { background: rgba(0,255,136,0.2); color: var(--accent-green); }
        .refresh-btn {
            background: linear-gradient(135deg, var(--accent), var(--accent-purple));
            border: none;
            color: white;
            padding: 10px 20px;
            border-radius: 8px;
            cursor: pointer;
            font-weight: 500;
            margin-bottom: 16px;
        }
        .refresh-btn:hover { opacity: 0.9; }
        .auto-refresh { color: var(--text-secondary); font-size: 0.875rem; margin-left: 12px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🔮 TokenSage Dashboard</h1>
        
        <button class="refresh-btn" onclick="loadStats()">Refresh</button>
        <span class="auto-refresh">Auto-refresh: 5s</span>
        
        <div class="stats-grid" id="statsGrid">
            <div class="stat-card">
                <div class="stat-label">Today's Tokens</div>
                <div class="stat-value tokens" id="todayTokens">-</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Today's Cost</div>
                <div class="stat-value cost" id="todayCost">-</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Today's Requests</div>
                <div class="stat-value requests" id="todayRequests">-</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">All-Time Tokens</div>
                <div class="stat-value tokens" id="totalTokens">-</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">All-Time Cost</div>
                <div class="stat-value cost" id="totalCost">-</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Total Requests</div>
                <div class="stat-value requests" id="totalRequests">-</div>
            </div>
        </div>
        
        <div class="requests-table">
            <div class="table-header">Recent Requests</div>
            <table>
                <thead>
                    <tr>
                        <th>Time</th>
                        <th>Provider</th>
                        <th>Model</th>
                        <th>Input</th>
                        <th>Output</th>
                        <th>Cost</th>
                        <th>Latency</th>
                    </tr>
                </thead>
                <tbody id="requestsBody"></tbody>
            </table>
        </div>
    </div>
    
    <script>
        const PROXY_URL = 'http://localhost:${PROXY_PORT}';
        
        async function loadStats() {
            try {
                const res = await fetch(PROXY_URL + '/stats');
                const data = await res.json();
                
                // Update stats
                if (data.daily) {
                    document.getElementById('todayTokens').textContent = (data.daily.totalTokens || 0).toLocaleString();
                    document.getElementById('todayCost').textContent = '$' + (data.daily.cost || 0).toFixed(4);
                    document.getElementById('todayRequests').textContent = (data.daily.requestCount || 0).toLocaleString();
                }
                
                if (data.total) {
                    document.getElementById('totalTokens').textContent = (data.total.totalTokens || 0).toLocaleString();
                    document.getElementById('totalCost').textContent = '$' + (data.total.totalCost || 0).toFixed(4);
                    document.getElementById('totalRequests').textContent = (data.total.requestCount || 0).toLocaleString();
                }
                
                // Update requests table
                const tbody = document.getElementById('requestsBody');
                tbody.innerHTML = '';
                
                (data.recentRequests || []).forEach(req => {
                    const row = document.createElement('tr');
                    const time = new Date(req.timestamp).toLocaleTimeString();
                    const providerClass = 'provider-' + (req.provider || 'unknown');
                    
                    row.innerHTML = \`
                        <td>\${time}</td>
                        <td><span class="provider-badge \${providerClass}">\${req.provider || 'unknown'}</span></td>
                        <td><span class="model-badge">\${req.model}</span></td>
                        <td>\${(req.inputTokens || 0).toLocaleString()}</td>
                        <td>\${(req.outputTokens || 0).toLocaleString()}</td>
                        <td>$\${(req.cost || 0).toFixed(6)}</td>
                        <td>\${req.latencyMs}ms</td>
                    \`;
                    tbody.appendChild(row);
                });
            } catch (err) {
                console.error('Failed to load stats:', err);
            }
        }
        
        // Initial load and auto-refresh
        loadStats();
        setInterval(loadStats, 5000);
    </script>
</body>
</html>`;
}

// Dashboard server
const dashboardServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(getDashboardHTML());
});

// Start servers
function startProxy(): void {
    proxyServer.listen(PROXY_PORT, () => {
        console.log('');
        console.log('╔════════════════════════════════════════════════════════════╗');
        console.log('║           🔮 TokenSage Proxy Server Started                ║');
        console.log('╠════════════════════════════════════════════════════════════╣');
        console.log(`║  Proxy URL:     http://localhost:${PROXY_PORT}                      ║`);
        console.log(`║  Dashboard:     http://localhost:${DASHBOARD_PORT}                      ║`);
        console.log('╠════════════════════════════════════════════════════════════╣');
        console.log('║  Stats API:     /stats, /history                           ║');
        console.log('╠════════════════════════════════════════════════════════════╣');
        console.log('║  Configure your IDE to use the proxy URL:                  ║');
        console.log('║                                                            ║');
        console.log('║  Cursor/Windsurf:                                          ║');
        console.log(`║    Set OPENAI_BASE_URL=http://localhost:${PROXY_PORT}/v1           ║`);
        console.log('║                                                            ║');
        console.log('║  Or use x-target-host header to specify target             ║');
        console.log('╚════════════════════════════════════════════════════════════╝');
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
