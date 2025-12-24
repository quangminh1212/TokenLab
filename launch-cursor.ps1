# TokenSage - Launch Cursor with Proxy
# This script starts the proxy and then launches Cursor with the correct environment

param(
    [switch]$NoProxy,
    [string]$ProxyPort = "4000"
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "╔════════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║           🔮 TokenSage - Launch Cursor with Tracking           ║" -ForegroundColor Cyan  
Write-Host "╚════════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectDir = $scriptDir

# Change to project directory
Set-Location $projectDir

# Check if proxy is already running
$proxyRunning = $false
try {
    $response = Invoke-WebRequest -Uri "http://localhost:$ProxyPort/health" -TimeoutSec 2 -ErrorAction SilentlyContinue
    if ($response.StatusCode -eq 200) {
        $proxyRunning = $true
        Write-Host "[INFO] Proxy is already running on port $ProxyPort" -ForegroundColor Green
    }
} catch {
    $proxyRunning = $false
}

# Start proxy if not running
if (-not $proxyRunning -and -not $NoProxy) {
    Write-Host "[INFO] Starting TokenSage Proxy..." -ForegroundColor Yellow
    
    # Start proxy in background
    $proxyJob = Start-Process -FilePath "npm" -ArgumentList "run", "proxy:dev" -WorkingDirectory $projectDir -WindowStyle Minimized -PassThru
    
    # Wait for proxy to start
    $maxWait = 10
    $waited = 0
    while ($waited -lt $maxWait) {
        Start-Sleep -Seconds 1
        $waited++
        try {
            $response = Invoke-WebRequest -Uri "http://localhost:$ProxyPort/health" -TimeoutSec 1 -ErrorAction SilentlyContinue
            if ($response.StatusCode -eq 200) {
                Write-Host "[SUCCESS] Proxy started successfully!" -ForegroundColor Green
                break
            }
        } catch {
            Write-Host "[WAIT] Waiting for proxy to start... ($waited/$maxWait)" -ForegroundColor Gray
        }
    }
}

# Set environment variables
$env:OPENAI_BASE_URL = "http://localhost:$ProxyPort/v1"
$env:OPENAI_API_BASE = "http://localhost:$ProxyPort/v1"
$env:ANTHROPIC_BASE_URL = "http://localhost:$ProxyPort/v1"

Write-Host ""
Write-Host "[INFO] Environment variables set:" -ForegroundColor Cyan
Write-Host "       OPENAI_BASE_URL = $env:OPENAI_BASE_URL" -ForegroundColor White
Write-Host "       ANTHROPIC_BASE_URL = $env:ANTHROPIC_BASE_URL" -ForegroundColor White
Write-Host ""

# Find Cursor executable
$cursorPaths = @(
    "$env:LOCALAPPDATA\Programs\cursor\Cursor.exe",
    "$env:PROGRAMFILES\Cursor\Cursor.exe",
    "$env:PROGRAMFILES(X86)\Cursor\Cursor.exe"
)

$cursorPath = $null
foreach ($path in $cursorPaths) {
    if (Test-Path $path) {
        $cursorPath = $path
        break
    }
}

if (-not $cursorPath) {
    # Try to find via where command
    try {
        $cursorPath = (Get-Command cursor -ErrorAction SilentlyContinue).Source
    } catch {
        $cursorPath = $null
    }
}

if (-not $cursorPath) {
    Write-Host "[WARNING] Cursor not found. Please start Cursor manually." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Manual steps:" -ForegroundColor Cyan
    Write-Host "1. Open a new terminal" -ForegroundColor White
    Write-Host "2. Run: `$env:OPENAI_BASE_URL=`"http://localhost:$ProxyPort/v1`"; cursor" -ForegroundColor White
    Write-Host ""
    Write-Host "Or configure manually in Cursor Settings > Models > Override OpenAI Base URL" -ForegroundColor White
} else {
    Write-Host "[INFO] Launching Cursor: $cursorPath" -ForegroundColor Cyan
    Start-Process -FilePath $cursorPath
}

# Open dashboard
Write-Host ""
Write-Host "[INFO] Opening dashboard in browser..." -ForegroundColor Cyan
Start-Process "http://localhost:4001"

Write-Host ""
Write-Host "╔════════════════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║                    ✅ Setup Complete!                          ║" -ForegroundColor Green
Write-Host "╠════════════════════════════════════════════════════════════════╣" -ForegroundColor Green
Write-Host "║  Dashboard: http://localhost:4001                              ║" -ForegroundColor Green
Write-Host "║  Proxy:     http://localhost:$ProxyPort                               ║" -ForegroundColor Green
Write-Host "║                                                                ║" -ForegroundColor Green
Write-Host "║  IMPORTANT: You may still need to configure Cursor manually:  ║" -ForegroundColor Yellow
Write-Host "║  Settings > Models > Override OpenAI Base URL                 ║" -ForegroundColor Yellow
Write-Host "║  Enter: http://localhost:$ProxyPort/v1                                ║" -ForegroundColor Yellow
Write-Host "╚════════════════════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""

Write-Host "Press any key to exit..." -ForegroundColor Gray
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
