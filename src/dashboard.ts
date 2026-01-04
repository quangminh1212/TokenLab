/**
 * TokenSage Dashboard HTML Generator
 * Windows Local App - AI Usage Tracker
 */

export function getDashboardHTML(proxyPort: number): string {
    const dollarSign = '\u0024';
    
    return `<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TokenSage - Theo dõi AI Usage</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-primary: #fafafa;
            --bg-secondary: #ffffff;
            --bg-card: #ffffff;
            --text-primary: #18181b;
            --text-secondary: #71717a;
            --text-muted: #a1a1aa;
            --border: #e4e4e7;
            --border-light: #f4f4f5;
            --accent: #6366f1;
            --accent-light: #eef2ff;
            --success: #10b981;
            --success-light: #ecfdf5;
            --warning: #f59e0b;
            --warning-light: #fffbeb;
            --error: #ef4444;
            --shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05);
            --shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1);
            --shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
            --radius: 12px;
            --radius-sm: 8px;
        }
        
        @media (prefers-color-scheme: dark) {
            :root {
                --bg-primary: #09090b;
                --bg-secondary: #18181b;
                --bg-card: #1f1f23;
                --text-primary: #fafafa;
                --text-secondary: #a1a1aa;
                --text-muted: #71717a;
                --border: #27272a;
                --border-light: #3f3f46;
                --accent-light: rgba(99, 102, 241, 0.15);
                --success-light: rgba(16, 185, 129, 0.15);
                --warning-light: rgba(245, 158, 11, 0.15);
            }
        }
        
        * { box-sizing: border-box; margin: 0; padding: 0; }
        
        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: var(--bg-primary);
            color: var(--text-primary);
            min-height: 100vh;
            line-height: 1.6;
            -webkit-font-smoothing: antialiased;
        }
        
        /* Header */
        .header {
            background: var(--bg-secondary);
            border-bottom: 1px solid var(--border);
            padding: 16px 24px;
            position: sticky;
            top: 0;
            z-index: 100;
            backdrop-filter: blur(8px);
        }
        
        .header-content {
            max-width: 1400px;
            margin: 0 auto;
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        
        .logo {
            display: flex;
            align-items: center;
            gap: 12px;
            text-decoration: none;
            color: var(--text-primary);
        }
        
        .logo-icon {
            width: 36px;
            height: 36px;
            background: linear-gradient(135deg, var(--accent), #8b5cf6);
            border-radius: 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 18px;
        }
        
        .logo-text {
            font-weight: 600;
            font-size: 1.25rem;
            letter-spacing: -0.025em;
        }
        
        .header-actions {
            display: flex;
            align-items: center;
            gap: 12px;
        }
        
        .status-badge {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 6px 12px;
            background: var(--success-light);
            color: var(--success);
            border-radius: 20px;
            font-size: 0.8125rem;
            font-weight: 500;
        }
        
        .status-dot {
            width: 8px;
            height: 8px;
            background: var(--success);
            border-radius: 50%;
            animation: pulse 2s infinite;
        }
        
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
        
        .btn {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 8px 16px;
            border-radius: var(--radius-sm);
            font-size: 0.875rem;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.15s ease;
            border: none;
            text-decoration: none;
        }
        
        .btn-primary {
            background: var(--accent);
            color: white;
        }
        
        .btn-primary:hover {
            background: #4f46e5;
            transform: translateY(-1px);
        }
        
        .btn-secondary {
            background: var(--bg-card);
            color: var(--text-primary);
            border: 1px solid var(--border);
        }
        
        .btn-secondary:hover {
            background: var(--border-light);
        }
        
        /* Main Content */
        .main {
            max-width: 1400px;
            margin: 0 auto;
            padding: 32px 24px;
        }
        
        /* Stats Grid */
        .stats-section {
            margin-bottom: 32px;
        }
        
        .section-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 20px;
        }
        
        .section-title {
            font-size: 0.875rem;
            font-weight: 500;
            color: var(--text-secondary);
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }
        
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 16px;
        }
        
        .stat-card {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: var(--radius);
            padding: 24px;
            transition: all 0.2s ease;
        }
        
        .stat-card:hover {
            box-shadow: var(--shadow-md);
            transform: translateY(-2px);
        }
        
        .stat-icon {
            width: 40px;
            height: 40px;
            border-radius: 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 18px;
            margin-bottom: 16px;
        }
        
        .stat-icon.tokens { background: var(--accent-light); }
        .stat-icon.cost { background: var(--success-light); }
        .stat-icon.requests { background: var(--warning-light); }
        
        .stat-label {
            font-size: 0.8125rem;
            color: var(--text-secondary);
            margin-bottom: 4px;
        }
        
        .stat-value {
            font-size: 1.875rem;
            font-weight: 600;
            letter-spacing: -0.025em;
            color: var(--text-primary);
        }
        
        .stat-change {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            font-size: 0.75rem;
            font-weight: 500;
            margin-top: 8px;
            padding: 2px 8px;
            border-radius: 4px;
        }
        
        .stat-change.up { background: var(--success-light); color: var(--success); }
        .stat-change.down { background: rgba(239, 68, 68, 0.1); color: var(--error); }
        
        /* Table Section */
        .table-section {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: var(--radius);
            overflow: hidden;
        }
        
        .table-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 20px 24px;
            border-bottom: 1px solid var(--border);
        }
        
        .table-title {
            font-size: 1rem;
            font-weight: 600;
        }
        
        .table-actions {
            display: flex;
            gap: 8px;
        }
        
        .table-wrapper {
            overflow-x: auto;
        }
        
        table {
            width: 100%;
            border-collapse: collapse;
        }
        
        th {
            text-align: left;
            padding: 12px 24px;
            font-size: 0.75rem;
            font-weight: 500;
            color: var(--text-muted);
            text-transform: uppercase;
            letter-spacing: 0.05em;
            background: var(--bg-primary);
            border-bottom: 1px solid var(--border);
        }
        
        td {
            padding: 16px 24px;
            font-size: 0.875rem;
            border-bottom: 1px solid var(--border-light);
        }
        
        tr:last-child td { border-bottom: none; }
        
        tr:hover td {
            background: var(--bg-primary);
        }
        
        /* Badges */
        .badge {
            display: inline-flex;
            align-items: center;
            padding: 4px 10px;
            border-radius: 6px;
            font-size: 0.75rem;
            font-weight: 500;
        }
        
        .badge-model {
            background: var(--accent-light);
            color: var(--accent);
        }
        
        .badge-provider {
            padding: 4px 10px;
            border-radius: 6px;
            font-size: 0.75rem;
            font-weight: 500;
        }
        
        .provider-openai { background: rgba(16, 163, 127, 0.1); color: #10a37f; }
        .provider-anthropic { background: rgba(204, 150, 103, 0.1); color: #cc9667; }
        .provider-google { background: rgba(66, 133, 244, 0.1); color: #4285f4; }
        .provider-cursor { background: rgba(139, 92, 246, 0.1); color: #8b5cf6; }
        .provider-windsurf { background: rgba(59, 130, 246, 0.1); color: #3b82f6; }
        .provider-kiro { background: rgba(255, 153, 0, 0.1); color: #ff9900; }
        .provider-copilot { background: rgba(110, 84, 148, 0.1); color: #6e5494; }
        .provider-aws { background: rgba(255, 153, 0, 0.1); color: #ff9900; }
        .provider-azure { background: rgba(0, 120, 212, 0.1); color: #0078d4; }
        .provider-deepseek { background: rgba(79, 70, 229, 0.1); color: #4f46e5; }
        .provider-groq { background: rgba(244, 63, 94, 0.1); color: #f43f5e; }
        .provider-together { background: rgba(16, 185, 129, 0.1); color: #10b981; }
        .provider-perplexity { background: rgba(99, 102, 241, 0.1); color: #6366f1; }
        .provider-mistral { background: rgba(249, 115, 22, 0.1); color: #f97316; }
        .provider-cohere { background: rgba(217, 70, 239, 0.1); color: #d946ef; }
        .provider-replicate { background: rgba(236, 72, 153, 0.1); color: #ec4899; }
        .provider-unknown { background: var(--border-light); color: var(--text-muted); }
        
        /* Token display */
        .token-cell {
            font-family: 'SF Mono', 'Fira Code', monospace;
            font-size: 0.8125rem;
        }
        
        .token-in { color: var(--accent); }
        .token-out { color: var(--success); }
        
        .cost-cell {
            font-family: 'SF Mono', 'Fira Code', monospace;
            font-size: 0.8125rem;
            color: var(--success);
        }
        
        .latency-cell {
            font-family: 'SF Mono', 'Fira Code', monospace;
            font-size: 0.8125rem;
            color: var(--text-muted);
        }
        
        .time-cell {
            color: var(--text-secondary);
            font-size: 0.8125rem;
        }
        
        /* Empty State */
        .empty-state {
            text-align: center;
            padding: 60px 24px;
            color: var(--text-muted);
        }
        
        .empty-icon {
            font-size: 48px;
            margin-bottom: 16px;
            opacity: 0.5;
        }
        
        .empty-title {
            font-size: 1rem;
            font-weight: 500;
            color: var(--text-secondary);
            margin-bottom: 8px;
        }
        
        .empty-desc {
            font-size: 0.875rem;
        }
        
        /* Log Panel */
        .log-section {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: var(--radius);
            overflow: hidden;
            margin-top: 24px;
        }
        
        .log-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 16px 24px;
            border-bottom: 1px solid var(--border);
            background: var(--bg-primary);
        }
        
        .log-title {
            font-size: 1rem;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .log-content {
            background: #1a1a2e;
            color: #e0e0e0;
            font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
            font-size: 0.8125rem;
            padding: 16px;
            height: 200px;
            overflow-y: auto;
            line-height: 1.8;
        }
        
        .log-entry {
            padding: 4px 0;
            border-bottom: 1px solid rgba(255,255,255,0.05);
        }
        
        .log-entry:last-child {
            border-bottom: none;
        }
        
        .log-time {
            color: #6b7280;
            margin-right: 8px;
        }
        
        .log-model {
            color: #818cf8;
            font-weight: 500;
        }
        
        .log-tokens {
            color: #34d399;
        }
        
        .log-cost {
            color: #fbbf24;
        }
        
        .log-provider {
            color: #f472b6;
        }
        
        .log-empty {
            color: #6b7280;
            text-align: center;
            padding: 40px;
        }
        
        /* Footer */
        .footer {
            max-width: 1400px;
            margin: 0 auto;
            padding: 24px;
            text-align: center;
            color: var(--text-muted);
            font-size: 0.8125rem;
        }
        
        .footer a {
            color: var(--accent);
            text-decoration: none;
        }
        
        .footer a:hover {
            text-decoration: underline;
        }
        
        /* Responsive */
        @media (max-width: 768px) {
            .header-content { flex-wrap: wrap; gap: 12px; }
            .stats-grid { grid-template-columns: 1fr 1fr; }
            th, td { padding: 12px 16px; }
            .main { padding: 20px 16px; }
        }
        
        @media (max-width: 480px) {
            .stats-grid { grid-template-columns: 1fr; }
        }
        
        /* Animations */
        .fade-in {
            animation: fadeIn 0.3s ease;
        }
        
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }
        
        /* Loading skeleton */
        .skeleton {
            background: linear-gradient(90deg, var(--border-light) 25%, var(--border) 50%, var(--border-light) 75%);
            background-size: 200% 100%;
            animation: shimmer 1.5s infinite;
            border-radius: 4px;
        }
        
        @keyframes shimmer {
            0% { background-position: 200% 0; }
            100% { background-position: -200% 0; }
        }
    </style>
</head>
<body>
    <header class="header">
        <div class="header-content">
            <a href="/" class="logo">
                <div class="logo-icon">⚡</div>
                <span class="logo-text">TokenSage</span>
            </a>
            <div class="header-actions">
                <div class="status-badge">
                    <span class="status-dot"></span>
                    <span>Live</span>
                </div>
                <button class="btn btn-secondary" onclick="loadStats()">
                    ↻ Refresh
                </button>
            </div>
        </div>
    </header>
    
    <main class="main">
        <section class="stats-section">
            <div class="section-header">
                <h2 class="section-title">Today's Overview</h2>
            </div>
            <div class="stats-grid">
                <div class="stat-card fade-in">
                    <div class="stat-icon tokens">📊</div>
                    <div class="stat-label">Tokens Used</div>
                    <div class="stat-value" id="todayTokens">-</div>
                </div>
                <div class="stat-card fade-in">
                    <div class="stat-icon cost">💰</div>
                    <div class="stat-label">Cost</div>
                    <div class="stat-value" id="todayCost">-</div>
                </div>
                <div class="stat-card fade-in">
                    <div class="stat-icon requests">📡</div>
                    <div class="stat-label">Requests</div>
                    <div class="stat-value" id="todayRequests">-</div>
                </div>
            </div>
        </section>
        
        <section class="stats-section">
            <div class="section-header">
                <h2 class="section-title">All Time</h2>
            </div>
            <div class="stats-grid">
                <div class="stat-card fade-in">
                    <div class="stat-icon tokens">📈</div>
                    <div class="stat-label">Total Tokens</div>
                    <div class="stat-value" id="totalTokens">-</div>
                </div>
                <div class="stat-card fade-in">
                    <div class="stat-icon cost">💵</div>
                    <div class="stat-label">Total Cost</div>
                    <div class="stat-value" id="totalCost">-</div>
                </div>
                <div class="stat-card fade-in">
                    <div class="stat-icon requests">🔢</div>
                    <div class="stat-label">Total Requests</div>
                    <div class="stat-value" id="totalRequests">-</div>
                </div>
            </div>
        </section>
        
        <section class="table-section fade-in">
            <div class="table-header">
                <h3 class="table-title">Recent Activity</h3>
                <div class="table-actions">
                    <span style="color: var(--text-muted); font-size: 0.8125rem;">Auto-refresh: 5s</span>
                </div>
            </div>
            <div class="table-wrapper">
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
                    <tbody id="requestsBody">
                        <tr>
                            <td colspan="7">
                                <div class="empty-state">
                                    <div class="empty-icon">📭</div>
                                    <div class="empty-title">No requests yet</div>
                                    <div class="empty-desc">Start using your AI tools to see usage data here</div>
                                </div>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </section>
        
        <section class="log-section fade-in">
            <div class="log-header">
                <h3 class="log-title">📋 Live Log</h3>
                <button class="btn btn-secondary" onclick="clearLogs()" style="padding: 4px 12px; font-size: 0.75rem;">Clear</button>
            </div>
            <div class="log-content" id="logContent">
                <div class="log-empty">Waiting for requests...</div>
            </div>
        </section>
    </main>
    
    <footer class="footer">
        <p>TokenSage - Theo dõi AI Usage • Proxy: <a href="http://localhost:${proxyPort}">localhost:${proxyPort}</a></p>
    </footer>
    
    <script>
        const PROXY_URL = 'http://localhost:${proxyPort}';
        const DOLLAR = '${dollarSign}';
        let lastRequestCount = 0;
        let logs = [];
        const MAX_LOGS = 50;
        
        function formatNumber(num) {
            if (num >= 1000000) return (num / 1000000).toFixed(2) + 'M';
            if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
            return num.toLocaleString();
        }
        
        function formatTime(date) {
            return new Date(date).toLocaleTimeString('vi-VN', { hour12: false });
        }
        
        function addLog(req) {
            const logEntry = {
                time: formatTime(req.timestamp),
                provider: req.provider || 'unknown',
                model: req.model || 'unknown',
                input: req.inputTokens || 0,
                output: req.outputTokens || 0,
                cost: req.cost || 0,
                latency: req.latencyMs || 0
            };
            logs.unshift(logEntry);
            if (logs.length > MAX_LOGS) logs.pop();
            renderLogs();
        }
        
        function renderLogs() {
            const logContent = document.getElementById('logContent');
            if (logs.length === 0) {
                logContent.innerHTML = '<div class="log-empty">Waiting for requests...</div>';
                return;
            }
            
            logContent.innerHTML = logs.map(log => 
                '<div class="log-entry">' +
                '<span class="log-time">[' + log.time + ']</span>' +
                '<span class="log-provider">' + log.provider + '</span> → ' +
                '<span class="log-model">' + log.model + '</span> | ' +
                '<span class="log-tokens">' + log.input + '+' + log.output + ' tokens</span> | ' +
                '<span class="log-cost">' + DOLLAR + log.cost.toFixed(6) + '</span> | ' +
                log.latency + 'ms' +
                '</div>'
            ).join('');
        }
        
        function clearLogs() {
            logs = [];
            renderLogs();
        }
        
        async function loadStats() {
            try {
                const res = await fetch(PROXY_URL + '/stats');
                const data = await res.json();
                
                if (data.daily) {
                    document.getElementById('todayTokens').textContent = formatNumber(data.daily.totalTokens || 0);
                    document.getElementById('todayCost').textContent = DOLLAR + (data.daily.cost || 0).toFixed(4);
                    document.getElementById('todayRequests').textContent = formatNumber(data.daily.requestCount || 0);
                }
                
                if (data.total) {
                    document.getElementById('totalTokens').textContent = formatNumber(data.total.totalTokens || 0);
                    document.getElementById('totalCost').textContent = DOLLAR + (data.total.totalCost || 0).toFixed(4);
                    document.getElementById('totalRequests').textContent = formatNumber(data.total.requestCount || 0);
                }
                
                // Add new requests to log
                if (data.recentRequests && data.recentRequests.length > 0) {
                    const newRequests = data.recentRequests.slice(0, data.recentRequests.length - lastRequestCount);
                    if (lastRequestCount > 0 && newRequests.length > 0) {
                        newRequests.reverse().forEach(req => addLog(req));
                    } else if (lastRequestCount === 0) {
                        // First load - add all
                        data.recentRequests.slice().reverse().forEach(req => addLog(req));
                    }
                    lastRequestCount = data.recentRequests.length;
                }
                
                const tbody = document.getElementById('requestsBody');
                
                if (!data.recentRequests || data.recentRequests.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><div class="empty-icon">📭</div><div class="empty-title">No requests yet</div><div class="empty-desc">Start using your AI tools to see usage data here</div></div></td></tr>';
                    return;
                }
                
                tbody.innerHTML = '';
                data.recentRequests.forEach(req => {
                    const row = document.createElement('tr');
                    const time = new Date(req.timestamp).toLocaleTimeString();
                    const provider = req.provider || 'unknown';
                    const providerClass = 'provider-' + provider;
                    
                    row.innerHTML = 
                        '<td class="time-cell">' + time + '</td>' +
                        '<td><span class="badge-provider ' + providerClass + '">' + provider + '</span></td>' +
                        '<td><span class="badge badge-model">' + (req.model || 'unknown') + '</span></td>' +
                        '<td class="token-cell token-in">' + formatNumber(req.inputTokens || 0) + '</td>' +
                        '<td class="token-cell token-out">' + formatNumber(req.outputTokens || 0) + '</td>' +
                        '<td class="cost-cell">' + DOLLAR + (req.cost || 0).toFixed(6) + '</td>' +
                        '<td class="latency-cell">' + (req.latencyMs || 0) + 'ms</td>';
                    tbody.appendChild(row);
                });
            } catch (err) {
                console.error('Failed to load stats:', err);
            }
        }
        
        // Initial load
        loadStats();
        
        // Auto refresh every 5 seconds
        setInterval(loadStats, 5000);
    </script>
</body>
</html>`;
}
