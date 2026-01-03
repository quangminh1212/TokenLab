@echo off
chcp 65001 >nul
echo.
echo ╔═══════════════════════════════════════════════════════════════╗
echo ║     🔮 TokenSage - Dashboard Test                             ║
echo ╚═══════════════════════════════════════════════════════════════╝
echo.
echo [INFO] Sending test data to dashboard...
echo.

:: Check if proxy is running
curl -s http://localhost:4000/health >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] TokenSage proxy not running!
    echo [INFO] Please run: run.bat
    pause
    exit /b 1
)

:: Send test data
echo [1/5] Sending OpenAI GPT-4o request...
curl -s -X POST http://localhost:4000/ingest -H "Content-Type: application/json" -d "{\"model\":\"gpt-4o\",\"input_tokens\":1500,\"output_tokens\":800,\"host\":\"api.openai.com\",\"path\":\"/v1/chat/completions\",\"request_id\":\"test_openai_1\",\"status_code\":200,\"latency_ms\":1234}"
echo.

echo [2/5] Sending Anthropic Claude request...
curl -s -X POST http://localhost:4000/ingest -H "Content-Type: application/json" -d "{\"model\":\"claude-3.5-sonnet\",\"input_tokens\":2000,\"output_tokens\":1200,\"host\":\"api.anthropic.com\",\"path\":\"/v1/messages\",\"request_id\":\"test_anthropic_1\",\"status_code\":200,\"latency_ms\":2345}"
echo.

echo [3/5] Sending Kiro/Bedrock request...
curl -s -X POST http://localhost:4000/ingest -H "Content-Type: application/json" -d "{\"model\":\"anthropic.claude-3-5-sonnet-20241022-v2:0\",\"input_tokens\":3500,\"output_tokens\":1800,\"host\":\"bedrock-runtime.us-east-1.amazonaws.com\",\"path\":\"/model/invoke\",\"request_id\":\"test_kiro_1\",\"status_code\":200,\"latency_ms\":3456}"
echo.

echo [4/5] Sending Cursor request...
curl -s -X POST http://localhost:4000/ingest -H "Content-Type: application/json" -d "{\"model\":\"gpt-4o-mini\",\"input_tokens\":800,\"output_tokens\":400,\"host\":\"api2.cursor.sh\",\"path\":\"/v1/chat/completions\",\"request_id\":\"test_cursor_1\",\"status_code\":200,\"latency_ms\":567}"
echo.

echo [5/5] Sending Google Gemini request...
curl -s -X POST http://localhost:4000/ingest -H "Content-Type: application/json" -d "{\"model\":\"gemini-1.5-pro\",\"input_tokens\":1200,\"output_tokens\":600,\"host\":\"generativelanguage.googleapis.com\",\"path\":\"/v1/models/gemini-1.5-pro:generateContent\",\"request_id\":\"test_google_1\",\"status_code\":200,\"latency_ms\":890}"
echo.

echo.
echo ╔═══════════════════════════════════════════════════════════════╗
echo ║  ✅ Test data sent successfully!                              ║
echo ║                                                               ║
echo ║  Open dashboard to see results:                               ║
echo ║  http://localhost:4001                                        ║
echo ╚═══════════════════════════════════════════════════════════════╝
echo.

start http://localhost:4001
pause
