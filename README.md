# MCP TokenSage

A Model Context Protocol (MCP) server for token counting, usage tracking, and cost calculation for LLM APIs.

## Features

- **🔢 Token Counting**: Accurate token counting using [tiktoken](https://github.com/openai/tiktoken) - the official OpenAI tokenizer
- **📊 Usage Tracking**: Track input/output tokens per session with detailed statistics
- **💰 Cost Calculation**: Calculate costs based on real pricing from major LLM providers
- **📈 Model Comparison**: Compare costs across different models (GPT-4, Claude, Gemini, etc.)
- **🎯 Project Estimation**: Estimate monthly/yearly costs for your AI projects

## Supported Models

### Token Counting
- GPT-4, GPT-4 Turbo, GPT-4o, GPT-4o Mini
- GPT-3.5 Turbo
- Claude 3/3.5 (approximate)
- Legacy models (davinci, curie, etc.)

### Pricing
- **OpenAI**: GPT-4o, GPT-4o Mini, GPT-4 Turbo, GPT-4, GPT-3.5 Turbo
- **Anthropic**: Claude 3.5 Sonnet/Haiku, Claude 3 Opus/Sonnet/Haiku
- **Google**: Gemini 1.5 Pro/Flash
- **DeepSeek**: DeepSeek Chat

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

### Development

```bash
# Run in development mode
npm run dev

# Run tests
npm test

# Lint
npm run lint
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

## License

MIT

## Author

quangminh1212