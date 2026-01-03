/**
 * TokenSage Dashboard HTML Generator
 * Modern, minimalist UI inspired by xlab.id.vn style
 */

export function getDashboardHTML(proxyPort: number): string {
    const dollarSign = '\u0024';

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TokenSage - AI Usage Dashboard</title>
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
        .provider-antigravity { background: rgba(26, 115, 232, 0.1); color: #1a73e8; }
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
                <button class="btn btn-primary" onclick="openSettings()">
                    ⚙️ Settings
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
    </main>
    
    <footer class="footer">
        <p>TokenSage Dashboard • Proxy: <a href="http://localhost:${proxyPort}">localhost:${proxyPort}</a></p>
    </footer>
    
    <script>
        const PROXY_URL = 'http://localhost:${proxyPort}';
        const DOLLAR = '${dollarSign}';
        
        function formatNumber(num) {
            if (num >= 1000000) return (num / 1000000).toFixed(2) + 'M';
            if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
            return num.toLocaleString();
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

        // Settings functions
        let currentSettings = null;

        async function loadSettings() {
            try {
                const res = await fetch(PROXY_URL + '/settings');
                currentSettings = await res.json();
                updateSettingsUI();
            } catch (err) {
                console.error('Failed to load settings:', err);
            }
        }

        function updateSettingsUI() {
            if (!currentSettings) return;
            
            document.getElementById('globalEnabled').checked = currentSettings.enabled;
            
            const container = document.getElementById('appToggles');
            container.innerHTML = '';
            
            for (const [key, app] of Object.entries(currentSettings.trackingApps)) {
                const row = document.createElement('div');
                row.className = 'app-toggle-row';
                row.innerHTML = 
                    '<div class=\"app-info\">' +
                    '<span class=\"app-icon\">' + app.icon + '</span>' +
                    '<span class=\"app-name\">' + app.name + '</span>' +
                    '</div>' +
                    '<label class=\"toggle\">' +
                    '<input type=\"checkbox\" ' + (app.enabled ? 'checked' : '') + ' onchange=\"toggleApp(\\'' + key + '\\')\">' +
                    '<span class=\"toggle-slider\"></span>' +
                    '</label>';
                container.appendChild(row);
            }
        }

        async function toggleApp(appName) {
            try {
                await fetch(PROXY_URL + '/settings/toggle/' + appName, { method: 'POST' });
                await loadSettings();
            } catch (err) {
                console.error('Failed to toggle app:', err);
            }
        }

        async function toggleGlobal() {
            if (!currentSettings) return;
            currentSettings.enabled = document.getElementById('globalEnabled').checked;
            try {
                await fetch(PROXY_URL + '/settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(currentSettings)
                });
            } catch (err) {
                console.error('Failed to update settings:', err);
            }
        }

        function openSettings() {
            loadSettings();
            document.getElementById('settingsModal').style.display = 'flex';
        }

        function closeSettings() {
            document.getElementById('settingsModal').style.display = 'none';
        }
    </script>

    <!-- Settings Modal -->
    <div id="settingsModal" class="modal" style="display: none;">
        <div class="modal-overlay" onclick="closeSettings()"></div>
        <div class="modal-content">
            <div class="modal-header">
                <h2>⚙️ Tracking Settings</h2>
                <button class="modal-close" onclick="closeSettings()">×</button>
            </div>
            <div class="modal-body">
                <div class="settings-section">
                    <h3>Global Settings</h3>
                    <div class="settings-row">
                        <span>Enable All Tracking</span>
                        <label class="toggle">
                            <input type="checkbox" id="globalEnabled" onchange="toggleGlobal()">
                            <span class="toggle-slider"></span>
                        </label>
                    </div>
                </div>
                <div class="settings-section">
                    <h3>Track Apps</h3>
                    <p class="settings-desc">Choose which AI coding assistants to track</p>
                    <div id="appToggles" class="app-toggles"></div>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="closeSettings()">Close</button>
            </div>
        </div>
    </div>

    <style>
        .modal { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: 1000; display: flex; align-items: center; justify-content: center; }
        .modal-overlay { position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.5); backdrop-filter: blur(4px); }
        .modal-content { position: relative; background: var(--bg-card); border-radius: var(--radius); box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25); width: 90%; max-width: 500px; max-height: 80vh; overflow: hidden; animation: modalSlideIn 0.2s ease; }
        @keyframes modalSlideIn { from { transform: translateY(-20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        .modal-header { display: flex; align-items: center; justify-content: space-between; padding: 20px 24px; border-bottom: 1px solid var(--border); }
        .modal-header h2 { font-size: 1.125rem; font-weight: 600; }
        .modal-close { width: 32px; height: 32px; border: none; background: none; font-size: 24px; cursor: pointer; color: var(--text-muted); border-radius: 6px; display: flex; align-items: center; justify-content: center; }
        .modal-close:hover { background: var(--border-light); color: var(--text-primary); }
        .modal-body { padding: 24px; overflow-y: auto; max-height: 60vh; }
        .modal-footer { padding: 16px 24px; border-top: 1px solid var(--border); display: flex; justify-content: flex-end; gap: 12px; }
        .settings-section { margin-bottom: 24px; }
        .settings-section:last-child { margin-bottom: 0; }
        .settings-section h3 { font-size: 0.875rem; font-weight: 600; margin-bottom: 8px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.05em; }
        .settings-desc { font-size: 0.8125rem; color: var(--text-muted); margin-bottom: 16px; }
        .settings-row { display: flex; align-items: center; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid var(--border-light); }
        .settings-row:last-child { border-bottom: none; }
        .app-toggles { display: grid; gap: 4px; }
        .app-toggle-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-radius: var(--radius-sm); transition: background 0.15s; }
        .app-toggle-row:hover { background: var(--bg-primary); }
        .app-info { display: flex; align-items: center; gap: 10px; }
        .app-icon { font-size: 1.25rem; }
        .app-name { font-weight: 500; font-size: 0.875rem; }
        .toggle { position: relative; display: inline-block; width: 44px; height: 24px; }
        .toggle input { opacity: 0; width: 0; height: 0; }
        .toggle-slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: var(--border); transition: 0.3s; border-radius: 24px; }
        .toggle-slider:before { position: absolute; content: ""; height: 18px; width: 18px; left: 3px; bottom: 3px; background-color: white; transition: 0.3s; border-radius: 50%; box-shadow: 0 1px 3px rgba(0,0,0,0.2); }
        .toggle input:checked + .toggle-slider { background-color: var(--accent); }
        .toggle input:checked + .toggle-slider:before { transform: translateX(20px); }
    </style>
</body>
</html>`;
}
