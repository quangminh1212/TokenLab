@echo off
echo Stopping TokenSage...

:: Kill processes
taskkill /f /im mitmdump.exe >nul 2>&1
taskkill /f /im mitmproxy.exe >nul 2>&1
taskkill /f /im node.exe >nul 2>&1

:: Restart Cloudflare WARP if it was installed
if exist "%ProgramFiles%\Cloudflare\Cloudflare WARP\Cloudflare WARP.exe" (
    echo Restarting Cloudflare WARP...
    net start CloudflareWARP >nul 2>&1
)

echo Done.
