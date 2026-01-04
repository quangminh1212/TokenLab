@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

echo.
echo ╔═══════════════════════════════════════════════════════════════╗
echo ║  🔍 TokenSage Fiddler Integration Setup                       ║
echo ╚═══════════════════════════════════════════════════════════════╝
echo.

cd /d "%~dp0"

:: Check if Fiddler is installed
set FIDDLER_PATH=
for %%P in (
    "%LOCALAPPDATA%\Programs\Fiddler\Fiddler.exe"
    "%ProgramFiles%\Fiddler\Fiddler.exe"
    "%ProgramFiles(x86)%\Fiddler\Fiddler.exe"
    "%LOCALAPPDATA%\Programs\Telerik\Fiddler Classic\Fiddler.exe"
    "%ProgramFiles%\Telerik\Fiddler Classic\Fiddler.exe"
) do (
    if exist "%%~P" (
        set "FIDDLER_PATH=%%~P"
        goto :found_fiddler
    )
)

:: Fiddler not found - download it
echo [INFO] Fiddler not found. Downloading Fiddler Classic...
echo.

set DOWNLOAD_URL=https://telerik-fiddler.s3.amazonaws.com/fiddler/FiddlerSetup.exe
set DOWNLOAD_PATH=%TEMP%\FiddlerSetup.exe

echo [INFO] Downloading from: %DOWNLOAD_URL%
curl -L -o "%DOWNLOAD_PATH%" "%DOWNLOAD_URL%"

if exist "%DOWNLOAD_PATH%" (
    echo [OK] Download complete!
    echo.
    echo [INFO] Running Fiddler installer...
    echo        Please complete the installation wizard.
    start /wait "" "%DOWNLOAD_PATH%"
    
    :: Re-check after installation
    for %%P in (
        "%LOCALAPPDATA%\Programs\Fiddler\Fiddler.exe"
        "%ProgramFiles%\Fiddler\Fiddler.exe"
        "%ProgramFiles(x86)%\Fiddler\Fiddler.exe"
        "%LOCALAPPDATA%\Programs\Telerik\Fiddler Classic\Fiddler.exe"
        "%ProgramFiles%\Telerik\Fiddler Classic\Fiddler.exe"
    ) do (
        if exist "%%~P" (
            set "FIDDLER_PATH=%%~P"
            goto :found_fiddler
        )
    )
    
    echo [ERROR] Fiddler installation not detected.
    echo         Please install manually from: https://www.telerik.com/download/fiddler
    pause
    exit /b 1
) else (
    echo [ERROR] Download failed!
    echo         Please download Fiddler manually from:
    echo         https://www.telerik.com/download/fiddler
    pause
    exit /b 1
)

:found_fiddler
echo [OK] Found Fiddler: %FIDDLER_PATH%
echo.

:: Create FiddlerScript to export AI traffic to TokenSage
echo [INFO] Creating TokenSage integration script...

set FIDDLER_SCRIPTS_DIR=%USERPROFILE%\Documents\Fiddler2\Scripts
if not exist "%FIDDLER_SCRIPTS_DIR%" mkdir "%FIDDLER_SCRIPTS_DIR%"

:: Create CustomRules.js with TokenSage integration
(
echo // TokenSage Integration for Fiddler
echo // This script sends AI API traffic data to TokenSage
echo.
echo import System;
echo import System.Windows.Forms;
echo import System.Net;
echo import System.Text;
echo import System.IO;
echo import Fiddler;
echo.
echo class Handlers
echo {
echo     // AI API domains to track
echo     static var aiDomains = [
echo         "api.openai.com",
echo         "api.anthropic.com",
echo         "generativelanguage.googleapis.com",
echo         "api.gemini.google.com",
echo         "antigravity.google",
echo         "api.cursor.sh",
echo         "api2.cursor.sh",
echo         "server.codeium.com",
echo         "api.cohere.ai",
echo         "api.mistral.ai",
echo         "api.groq.com",
echo         "api.deepseek.com",
echo         "api.together.xyz",
echo         "bedrock-runtime"
echo     ];
echo.
echo     // TokenSage API endpoint
echo     static var tokensageUrl = "http://localhost:4000/ingest";
echo.
echo     static function isAiRequest^(host: String^): Boolean {
echo         for ^(var i = 0; i ^< aiDomains.length; i++^) {
echo             if ^(host.indexOf^(aiDomains[i]^) ^>= 0^) return true;
echo         }
echo         return false;
echo     }
echo.
echo     static function OnBeforeResponse^(oSession: Session^) {
echo         if ^(!isAiRequest^(oSession.hostname^)^) return;
echo.
echo         try {
echo             // Extract usage data from response
echo             var responseBody = oSession.GetResponseBodyAsString^(^);
echo             var inputTokens = 0;
echo             var outputTokens = 0;
echo             var model = "unknown";
echo.
echo             // Try to parse JSON response for token usage
echo             if ^(responseBody.indexOf^("usage"^) ^> 0^) {
echo                 // OpenAI format
echo                 var match = responseBody.match^(/"prompt_tokens"\s*:\s*^(\d+^)/^);
echo                 if ^(match^) inputTokens = parseInt^(match[1]^);
echo                 match = responseBody.match^(/"completion_tokens"\s*:\s*^(\d+^)/^);
echo                 if ^(match^) outputTokens = parseInt^(match[1]^);
echo                 
echo                 // Anthropic format
echo                 match = responseBody.match^(/"input_tokens"\s*:\s*^(\d+^)/^);
echo                 if ^(match^) inputTokens = parseInt^(match[1]^);
echo                 match = responseBody.match^(/"output_tokens"\s*:\s*^(\d+^)/^);
echo                 if ^(match^) outputTokens = parseInt^(match[1]^);
echo             }
echo.
echo             // Extract model
echo             var modelMatch = responseBody.match^(/"model"\s*:\s*"^([^"]+^)"/^);
echo             if ^(modelMatch^) model = modelMatch[1];
echo.
echo             // Send to TokenSage if we have token data
echo             if ^(inputTokens ^> 0 ^|^| outputTokens ^> 0^) {
echo                 var data = "{" +
echo                     "\"model\":\"" + model + "\"," +
echo                     "\"input_tokens\":" + inputTokens + "," +
echo                     "\"output_tokens\":" + outputTokens + "," +
echo                     "\"host\":\"" + oSession.hostname + "\"," +
echo                     "\"path\":\"" + oSession.PathAndQuery + "\"," +
echo                     "\"status_code\":" + oSession.responseCode +
echo                 "}";
echo.
echo                 var request = WebRequest.Create^(tokensageUrl^) as HttpWebRequest;
echo                 request.Method = "POST";
echo                 request.ContentType = "application/json";
echo                 request.Timeout = 5000;
echo.
echo                 var bytes = Encoding.UTF8.GetBytes^(data^);
echo                 request.ContentLength = bytes.Length;
echo.
echo                 var stream = request.GetRequestStream^(^);
echo                 stream.Write^(bytes, 0, bytes.Length^);
echo                 stream.Close^(^);
echo.
echo                 var response = request.GetResponse^(^);
echo                 response.Close^(^);
echo.
echo                 FiddlerApplication.Log.LogString^("TokenSage: Sent " + model + " " + inputTokens + "+" + outputTokens + " tokens"^);
echo             }
echo         } catch ^(e^) {
echo             // Silently ignore errors
echo         }
echo     }
echo }
) > "%FIDDLER_SCRIPTS_DIR%\TokenSageIntegration.js"

echo [OK] Created: %FIDDLER_SCRIPTS_DIR%\TokenSageIntegration.js
echo.

echo ╔═══════════════════════════════════════════════════════════════╗
echo ║  ✅ Setup Complete!                                           ║
echo ╠═══════════════════════════════════════════════════════════════╣
echo ║  How to use:                                                  ║
echo ║                                                               ║
echo ║  1. Start TokenSage first:                                    ║
echo ║     run.bat                                                   ║
echo ║                                                               ║
echo ║  2. Open Fiddler Classic                                      ║
echo ║                                                               ║
echo ║  3. Enable HTTPS Decryption:                                  ║
echo ║     Tools → Options → HTTPS → Decrypt HTTPS traffic          ║
echo ║                                                               ║
echo ║  4. Load TokenSage script:                                    ║
echo ║     Rules → Customize Rules → Paste content from:            ║
echo ║     %FIDDLER_SCRIPTS_DIR%\TokenSageIntegration.js             ║
echo ║                                                               ║
echo ║  5. Use your AI IDE normally - traffic will be captured!     ║
echo ║                                                               ║
echo ║  Dashboard: http://localhost:4001                             ║
echo ╚═══════════════════════════════════════════════════════════════╝
echo.

:: Ask if user wants to open Fiddler
set /p OPEN_FIDDLER="Open Fiddler now? (Y/N): "
if /i "%OPEN_FIDDLER%"=="Y" (
    start "" "%FIDDLER_PATH%"
)

pause
