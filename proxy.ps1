# Toggle Windows System Proxy for mitmproxy
# Run as: .\proxy.ps1 on|off|status

param(
    [Parameter(Position = 0)]
    [string]$Action = "status"
)

$proxyServer = "127.0.0.1:8080"
$regPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings"

function Get-ProxyStatus {
    $enabled = (Get-ItemProperty -Path $regPath -Name ProxyEnable -ErrorAction SilentlyContinue).ProxyEnable
    $server = (Get-ItemProperty -Path $regPath -Name ProxyServer -ErrorAction SilentlyContinue).ProxyServer
    return @{Enabled = ($enabled -eq 1); Server = $server }
}

function Set-ProxyOn {
    Set-ItemProperty -Path $regPath -Name ProxyEnable -Value 1
    Set-ItemProperty -Path $regPath -Name ProxyServer -Value $proxyServer
    Set-ItemProperty -Path $regPath -Name ProxyOverride -Value "localhost;127.*;10.*;192.168.*;*.local"
    Write-Host "Proxy ENABLED: $proxyServer" -ForegroundColor Green
    Write-Host "Bypass: localhost, local networks" -ForegroundColor Gray
}

function Set-ProxyOff {
    Set-ItemProperty -Path $regPath -Name ProxyEnable -Value 0
    Write-Host "Proxy DISABLED" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "TokenSage - Proxy Toggle Utility" -ForegroundColor Cyan
Write-Host ""

$status = Get-ProxyStatus

if ($Action -eq "on") {
    if (-not $status.Enabled) {
        Set-ProxyOn
    }
    else {
        Write-Host "Proxy already enabled: $($status.Server)" -ForegroundColor Cyan
    }
}
elseif ($Action -eq "off") {
    if ($status.Enabled) {
        Set-ProxyOff
    }
    else {
        Write-Host "Proxy already disabled" -ForegroundColor Cyan
    }
}
else {
    if ($status.Enabled) {
        Write-Host "Proxy Status: ENABLED" -ForegroundColor Green
        Write-Host "Server: $($status.Server)" -ForegroundColor Gray
    }
    else {
        Write-Host "Proxy Status: DISABLED" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "Usage: .\proxy.ps1 [on|off|status]" -ForegroundColor DarkGray
