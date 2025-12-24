# MCP TokenSage

A Model Context Protocol (MCP) server for token counting, usage tracking, and cost calculation for LLM APIs.

**Now with Proxy Server Mode** - Automatically track token usage by intercepting API requests from Cursor, Windsurf, or any LLM client!

## Features

- **🚀 Proxy Server Mode (NEW!)**: Intercept API requests and auto-track token usage - no cookies needed!
- **🔢 Token Counting**: Accurate token counting using [tiktoken](https://github.com/openai/tiktoken)
- **📊 Usage Tracking**: Track input/output tokens per session with detailed statistics
- **💰 Cost Calculation**: Calculate costs based on real pricing from major LLM providers
- **📈 Model Comparison**: Compare costs across different models
- **🎯 Project Estimation**: Estimate monthly/yearly costs for your AI projects
- **🔄 Auto-Update**: Crawl latest model data from OpenRouter API
- **📱 Real-time Dashboard**: View usage stats in a beautiful web dashboard

## Quick Start - Proxy Mode

The easiest way to track your token usage from Cursor/Windsurf:

```bash
# Start the proxy server
npm run proxy:dev

# Or production mode
npm run proxy
```

Then configure your IDE:
- **Proxy URL**: `http://localhost:4000`
- **Dashboard**: `http://localhost:4001`

### Configure Cursor/Windsurf

Set the API base URL to the proxy:

```bash
# For OpenAI models
OPENAI_BASE_URL=http://localhost:4000/v1

# For Anthropic models  
ANTHROPIC_BASE_URL=http://localhost:4000/v1
```

All your API requests will now be automatically tracked with:
- ✅ Token count (input + output)
- ✅ Cost calculation
- ✅ Model detection
- ✅ Latency monitoring
- ✅ Persistent storage

## Supported Models

### 350+ Models from 15+ Providers

| Provider | Models |
|----------|--------|
| **OpenAI** | GPT-4o, GPT-4o Mini, GPT-4 Turbo, o1, o3-mini, Embeddings |
| **Anthropic** | Claude 3.5 Sonnet/Haiku, Claude 3 Opus/Sonnet/Haiku |
| **Google** | Gemini 2.0, Gemini 1.5 Pro/Flash |
| **Meta** | Llama 3.3, 3.2, 3.1, Code Llama |
| **Mistral** | Mistral Large/Medium/Small, Mixtral, Codestral |
| **DeepSeek** | DeepSeek V3, Chat, Coder |
| **Alibaba** | Qwen Max/Plus/Turbo, Qwen 2.5 |
| **xAI** | Grok 2, Grok Vision |
| **Cohere** | Command R+, Command R |
| **Amazon** | Nova Pro/Lite/Micro, Titan |
| **AI21** | Jamba 1.5, Jurassic-2 |
| **+ More** | Perplexity, Yi, GLM, Inflection... |

## Installation

```bash
# Clone the repository
git clone https://github.com/quangminh1212/MCP_TokenSage.git
cd MCP_TokenSage

# Install dependencies
npm install

# Build
npm run build
```

## Usage

### As MCP Server

Add to your MCP client configuration:

```json
{
  "mcpServers": {
    "tokensage": {
      "command": "node",
      "args": ["path/to/MCP_TokenSage/dist/index.js"]
    }
  }
}
```

### Update Model Data

```bash
# Update pricing data from OpenRouter API
npm run update-models

# Or use the batch script (Windows)
update-models.bat
```

### Development

```bash
# Run in development mode
npm run dev

# Run tests
npm test

# Lint
npm run lint
```

## Project Structure

```
MCP_TokenSage/
├── src/
│   ├── index.ts          # MCP Server với 10 tools
│   ├── tokenCounter.ts   # Token counting với tiktoken
│   ├── costCalculator.ts # Cost calculation với pricing data
│   ├── usageTracker.ts   # Session usage tracking
│   ├── crawler.ts        # OpenRouter API crawler
│   ├── modelLoader.ts    # Data loader với caching
│   ├── config.ts         # Configuration constants
│   ├── types.ts          # TypeScript type definitions
│   └── test.ts           # Test suite
├── data/
│   ├── models.json       # Full model data (từ crawler)
│   ├── pricing.json      # Pricing data
│   └── encodings.json    # Token encoding mappings
├── dist/                 # Build output
├── package.json
├── tsconfig.json
├── update-models.bat     # Windows script để update data
└── README.md
```

## Available Tools

### `count_tokens`
Count tokens in a text string.

```json
{
  "text": "Hello, how are you?",
  "model": "gpt-4",
  "include_tokens": false
}
```

### `count_tokens_batch`
Count tokens for multiple texts at once.

```json
{
  "texts": ["Hello", "World"],
  "model": "gpt-4"
}
```

### `record_usage`
Record token usage for a request.

```json
{
  "model": "gpt-4o",
  "input_tokens": 150,
  "output_tokens": 500,
  "request_id": "req_123"
}
```

### `get_usage_stats`
Get usage statistics for the current session.

```json
{
  "limit": 10
}
```

### `calculate_cost`
Calculate cost for a request.

```json
{
  "model": "gpt-4o",
  "input_tokens": 1000,
  "output_tokens": 2000
}
```

### `compare_models`
Compare costs across different models.

```json
{
  "input_tokens": 10000,
  "output_tokens": 20000,
  "models": ["gpt-4o", "gpt-4o-mini", "claude-3.5-sonnet"]
}
```

### `get_pricing`
Get pricing information for all supported models.

### `estimate_project`
Estimate project costs.

```json
{
  "model": "gpt-4o",
  "daily_input_tokens": 100000,
  "daily_output_tokens": 200000,
  "days": 30
}
```

### `get_supported_models`
Get list of models supported for token counting.

### `reset_usage`
Reset usage statistics.

## Example Output

### Cost Calculation
```json
{
  "model": "gpt-4o",
  "inputTokens": 1000,
  "outputTokens": 2000,
  "totalTokens": 3000,
  "inputCost": 0.0025,
  "outputCost": 0.02,
  "totalCost": 0.0225,
  "currency": "USD",
  "pricing": {
    "name": "GPT-4o",
    "inputPricePer1M": 2.5,
    "outputPricePer1M": 10,
    "contextWindow": 128000
  }
}
```

### Model Comparison (Top 5 Cheapest)
```
1. Gemini 2.0 Flash Exp: $0.0000
2. DeepSeek Chat: $0.0700
3. GPT-4o Mini: $0.1350
4. Claude 3 Haiku: $0.2750
5. Mistral Small: $0.8000
```

## Configuration

Configuration is centralized in `src/config.ts`:

- **Cache timeout**: 5 minutes
- **Default encoding**: cl100k_base
- **Cost decimals**: 6 places
- **API endpoints**: OpenRouter

## Data Sources

- **Primary**: [OpenRouter API](https://openrouter.ai/api/v1/models) - 350+ models with real-time pricing
- **Fallback**: Hardcoded data in `costCalculator.ts` - Updated December 2024

## License

MIT

## Author

quangminh1212