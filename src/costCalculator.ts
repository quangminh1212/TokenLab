/**
 * Cost Calculator - Tính chi phí sử dụng token theo model
 */

export interface ModelPricing {
    name: string;
    inputPricePer1M: number;  // USD per 1M tokens
    outputPricePer1M: number; // USD per 1M tokens
    contextWindow: number;
    description?: string;
}

// Pricing data (Updated December 2024)
// Prices are in USD per 1 Million tokens
export const MODEL_PRICING: Record<string, ModelPricing> = {
    // ==================== OpenAI Models ====================
    // GPT-4o Series
    'gpt-4o': {
        name: 'GPT-4o',
        inputPricePer1M: 2.50,
        outputPricePer1M: 10.00,
        contextWindow: 128000,
        description: 'Most capable multimodal GPT-4 model',
    },
    'gpt-4o-2024-11-20': {
        name: 'GPT-4o (Nov 2024)',
        inputPricePer1M: 2.50,
        outputPricePer1M: 10.00,
        contextWindow: 128000,
        description: 'GPT-4o November 2024 snapshot',
    },
    'gpt-4o-mini': {
        name: 'GPT-4o Mini',
        inputPricePer1M: 0.15,
        outputPricePer1M: 0.60,
        contextWindow: 128000,
        description: 'Affordable small GPT-4o variant',
    },
    'chatgpt-4o-latest': {
        name: 'ChatGPT-4o Latest',
        inputPricePer1M: 5.00,
        outputPricePer1M: 15.00,
        contextWindow: 128000,
        description: 'Latest ChatGPT model',
    },
    // GPT-4 Turbo Series
    'gpt-4-turbo': {
        name: 'GPT-4 Turbo',
        inputPricePer1M: 10.00,
        outputPricePer1M: 30.00,
        contextWindow: 128000,
        description: 'GPT-4 with 128K context',
    },
    'gpt-4-turbo-preview': {
        name: 'GPT-4 Turbo Preview',
        inputPricePer1M: 10.00,
        outputPricePer1M: 30.00,
        contextWindow: 128000,
        description: 'GPT-4 Turbo preview version',
    },
    // GPT-4 Base Series
    'gpt-4': {
        name: 'GPT-4',
        inputPricePer1M: 30.00,
        outputPricePer1M: 60.00,
        contextWindow: 8192,
        description: 'Original GPT-4 8K model',
    },
    'gpt-4-32k': {
        name: 'GPT-4 32K',
        inputPricePer1M: 60.00,
        outputPricePer1M: 120.00,
        contextWindow: 32768,
        description: 'GPT-4 with 32K context',
    },
    // GPT-3.5 Turbo Series
    'gpt-3.5-turbo': {
        name: 'GPT-3.5 Turbo',
        inputPricePer1M: 0.50,
        outputPricePer1M: 1.50,
        contextWindow: 16385,
        description: 'Fast and affordable',
    },
    'gpt-3.5-turbo-16k': {
        name: 'GPT-3.5 Turbo 16K',
        inputPricePer1M: 3.00,
        outputPricePer1M: 4.00,
        contextWindow: 16385,
        description: 'GPT-3.5 with 16K context',
    },
    'gpt-3.5-turbo-instruct': {
        name: 'GPT-3.5 Turbo Instruct',
        inputPricePer1M: 1.50,
        outputPricePer1M: 2.00,
        contextWindow: 4096,
        description: 'Instruction-tuned GPT-3.5',
    },
    // OpenAI o1/o3 Reasoning Models
    'o1': {
        name: 'o1',
        inputPricePer1M: 15.00,
        outputPricePer1M: 60.00,
        contextWindow: 200000,
        description: 'OpenAI reasoning model',
    },
    'o1-preview': {
        name: 'o1 Preview',
        inputPricePer1M: 15.00,
        outputPricePer1M: 60.00,
        contextWindow: 128000,
        description: 'o1 preview version',
    },
    'o1-mini': {
        name: 'o1 Mini',
        inputPricePer1M: 3.00,
        outputPricePer1M: 12.00,
        contextWindow: 128000,
        description: 'Smaller o1 variant',
    },
    'o3-mini': {
        name: 'o3 Mini',
        inputPricePer1M: 1.10,
        outputPricePer1M: 4.40,
        contextWindow: 200000,
        description: 'Latest reasoning model',
    },
    // OpenAI Embeddings
    'text-embedding-3-large': {
        name: 'Embedding 3 Large',
        inputPricePer1M: 0.13,
        outputPricePer1M: 0.00,
        contextWindow: 8191,
        description: 'Best embedding model',
    },
    'text-embedding-3-small': {
        name: 'Embedding 3 Small',
        inputPricePer1M: 0.02,
        outputPricePer1M: 0.00,
        contextWindow: 8191,
        description: 'Affordable embedding model',
    },
    'text-embedding-ada-002': {
        name: 'Embedding Ada 002',
        inputPricePer1M: 0.10,
        outputPricePer1M: 0.00,
        contextWindow: 8191,
        description: 'Legacy embedding model',
    },

    // ==================== Anthropic Claude Models ====================
    // Claude 3.5 Series
    'claude-3-5-sonnet-20241022': {
        name: 'Claude 3.5 Sonnet (Oct 2024)',
        inputPricePer1M: 3.00,
        outputPricePer1M: 15.00,
        contextWindow: 200000,
        description: 'Latest Claude 3.5 Sonnet',
    },
    'claude-3.5-sonnet': {
        name: 'Claude 3.5 Sonnet',
        inputPricePer1M: 3.00,
        outputPricePer1M: 15.00,
        contextWindow: 200000,
        description: 'Best Claude for most tasks',
    },
    'claude-3-5-haiku-20241022': {
        name: 'Claude 3.5 Haiku',
        inputPricePer1M: 0.80,
        outputPricePer1M: 4.00,
        contextWindow: 200000,
        description: 'Fast and affordable Claude 3.5',
    },
    'claude-3.5-haiku': {
        name: 'Claude 3.5 Haiku',
        inputPricePer1M: 0.80,
        outputPricePer1M: 4.00,
        contextWindow: 200000,
        description: 'Fast and affordable Claude 3.5',
    },
    // Claude 3 Series
    'claude-3-opus': {
        name: 'Claude 3 Opus',
        inputPricePer1M: 15.00,
        outputPricePer1M: 75.00,
        contextWindow: 200000,
        description: 'Most powerful Claude 3',
    },
    'claude-3-sonnet': {
        name: 'Claude 3 Sonnet',
        inputPricePer1M: 3.00,
        outputPricePer1M: 15.00,
        contextWindow: 200000,
        description: 'Balanced Claude 3',
    },
    'claude-3-haiku': {
        name: 'Claude 3 Haiku',
        inputPricePer1M: 0.25,
        outputPricePer1M: 1.25,
        contextWindow: 200000,
        description: 'Fast Claude 3',
    },
    // Claude 2 Series
    'claude-2.1': {
        name: 'Claude 2.1',
        inputPricePer1M: 8.00,
        outputPricePer1M: 24.00,
        contextWindow: 200000,
        description: 'Legacy Claude 2.1',
    },
    'claude-2': {
        name: 'Claude 2',
        inputPricePer1M: 8.00,
        outputPricePer1M: 24.00,
        contextWindow: 100000,
        description: 'Legacy Claude 2',
    },
    'claude-instant-1.2': {
        name: 'Claude Instant 1.2',
        inputPricePer1M: 0.80,
        outputPricePer1M: 2.40,
        contextWindow: 100000,
        description: 'Fast legacy Claude',
    },

    // ==================== Google Models ====================
    // Gemini 2.0
    'gemini-2.0-flash-exp': {
        name: 'Gemini 2.0 Flash Exp',
        inputPricePer1M: 0.00,
        outputPricePer1M: 0.00,
        contextWindow: 1000000,
        description: 'Experimental Gemini 2.0 (Free)',
    },
    'gemini-2.0-flash-thinking-exp': {
        name: 'Gemini 2.0 Flash Thinking',
        inputPricePer1M: 0.00,
        outputPricePer1M: 0.00,
        contextWindow: 1000000,
        description: 'Reasoning Gemini 2.0 (Free)',
    },
    // Gemini 1.5
    'gemini-1.5-pro': {
        name: 'Gemini 1.5 Pro',
        inputPricePer1M: 1.25,
        outputPricePer1M: 5.00,
        contextWindow: 2000000,
        description: 'Most capable Gemini',
    },
    'gemini-1.5-flash': {
        name: 'Gemini 1.5 Flash',
        inputPricePer1M: 0.075,
        outputPricePer1M: 0.30,
        contextWindow: 1000000,
        description: 'Fast Gemini model',
    },
    'gemini-1.5-flash-8b': {
        name: 'Gemini 1.5 Flash 8B',
        inputPricePer1M: 0.0375,
        outputPricePer1M: 0.15,
        contextWindow: 1000000,
        description: 'Smallest Gemini 1.5',
    },
    // Gemini 1.0
    'gemini-1.0-pro': {
        name: 'Gemini 1.0 Pro',
        inputPricePer1M: 0.50,
        outputPricePer1M: 1.50,
        contextWindow: 32760,
        description: 'Legacy Gemini Pro',
    },
    'gemini-pro': {
        name: 'Gemini Pro',
        inputPricePer1M: 0.50,
        outputPricePer1M: 1.50,
        contextWindow: 32760,
        description: 'Legacy Gemini Pro',
    },

    // ==================== Meta Llama Models (via API providers) ====================
    'llama-3.3-70b': {
        name: 'Llama 3.3 70B',
        inputPricePer1M: 0.59,
        outputPricePer1M: 0.79,
        contextWindow: 128000,
        description: 'Latest Llama model',
    },
    'llama-3.2-90b-vision': {
        name: 'Llama 3.2 90B Vision',
        inputPricePer1M: 0.90,
        outputPricePer1M: 0.90,
        contextWindow: 128000,
        description: 'Multimodal Llama',
    },
    'llama-3.2-11b-vision': {
        name: 'Llama 3.2 11B Vision',
        inputPricePer1M: 0.18,
        outputPricePer1M: 0.18,
        contextWindow: 128000,
        description: 'Small multimodal Llama',
    },
    'llama-3.2-3b': {
        name: 'Llama 3.2 3B',
        inputPricePer1M: 0.06,
        outputPricePer1M: 0.06,
        contextWindow: 128000,
        description: 'Compact Llama model',
    },
    'llama-3.2-1b': {
        name: 'Llama 3.2 1B',
        inputPricePer1M: 0.04,
        outputPricePer1M: 0.04,
        contextWindow: 128000,
        description: 'Smallest Llama model',
    },
    'llama-3.1-405b': {
        name: 'Llama 3.1 405B',
        inputPricePer1M: 3.00,
        outputPricePer1M: 3.00,
        contextWindow: 128000,
        description: 'Largest open model',
    },
    'llama-3.1-70b': {
        name: 'Llama 3.1 70B',
        inputPricePer1M: 0.59,
        outputPricePer1M: 0.79,
        contextWindow: 128000,
        description: 'Large Llama 3.1',
    },
    'llama-3.1-8b': {
        name: 'Llama 3.1 8B',
        inputPricePer1M: 0.05,
        outputPricePer1M: 0.08,
        contextWindow: 128000,
        description: 'Small Llama 3.1',
    },
    'llama-3-70b': {
        name: 'Llama 3 70B',
        inputPricePer1M: 0.59,
        outputPricePer1M: 0.79,
        contextWindow: 8192,
        description: 'Original Llama 3 large',
    },
    'llama-3-8b': {
        name: 'Llama 3 8B',
        inputPricePer1M: 0.05,
        outputPricePer1M: 0.08,
        contextWindow: 8192,
        description: 'Original Llama 3 small',
    },
    'codellama-70b': {
        name: 'Code Llama 70B',
        inputPricePer1M: 0.70,
        outputPricePer1M: 0.90,
        contextWindow: 16384,
        description: 'Coding-focused Llama',
    },

    // ==================== Mistral AI Models ====================
    'mistral-large': {
        name: 'Mistral Large',
        inputPricePer1M: 2.00,
        outputPricePer1M: 6.00,
        contextWindow: 128000,
        description: 'Most capable Mistral',
    },
    'mistral-large-2411': {
        name: 'Mistral Large (Nov 2024)',
        inputPricePer1M: 2.00,
        outputPricePer1M: 6.00,
        contextWindow: 128000,
        description: 'Latest Mistral Large',
    },
    'mistral-medium': {
        name: 'Mistral Medium',
        inputPricePer1M: 2.70,
        outputPricePer1M: 8.10,
        contextWindow: 32000,
        description: 'Balanced Mistral model',
    },
    'mistral-small': {
        name: 'Mistral Small',
        inputPricePer1M: 0.20,
        outputPricePer1M: 0.60,
        contextWindow: 128000,
        description: 'Affordable Mistral',
    },
    'mistral-7b': {
        name: 'Mistral 7B',
        inputPricePer1M: 0.04,
        outputPricePer1M: 0.04,
        contextWindow: 32768,
        description: 'Open-source Mistral 7B',
    },
    'mixtral-8x7b': {
        name: 'Mixtral 8x7B',
        inputPricePer1M: 0.24,
        outputPricePer1M: 0.24,
        contextWindow: 32768,
        description: 'MoE model - 46.7B params',
    },
    'mixtral-8x22b': {
        name: 'Mixtral 8x22B',
        inputPricePer1M: 0.65,
        outputPricePer1M: 0.65,
        contextWindow: 65536,
        description: 'Large MoE model - 176B params',
    },
    'codestral': {
        name: 'Codestral',
        inputPricePer1M: 0.20,
        outputPricePer1M: 0.60,
        contextWindow: 32000,
        description: 'Coding-focused Mistral',
    },
    'pixtral-12b': {
        name: 'Pixtral 12B',
        inputPricePer1M: 0.15,
        outputPricePer1M: 0.15,
        contextWindow: 128000,
        description: 'Multimodal Mistral',
    },
    'ministral-3b': {
        name: 'Ministral 3B',
        inputPricePer1M: 0.04,
        outputPricePer1M: 0.04,
        contextWindow: 128000,
        description: 'Tiny Mistral model',
    },
    'ministral-8b': {
        name: 'Ministral 8B',
        inputPricePer1M: 0.10,
        outputPricePer1M: 0.10,
        contextWindow: 128000,
        description: 'Small Mistral model',
    },

    // ==================== Cohere Models ====================
    'command-r-plus': {
        name: 'Command R+',
        inputPricePer1M: 2.50,
        outputPricePer1M: 10.00,
        contextWindow: 128000,
        description: 'Most capable Cohere model',
    },
    'command-r': {
        name: 'Command R',
        inputPricePer1M: 0.15,
        outputPricePer1M: 0.60,
        contextWindow: 128000,
        description: 'Balanced Cohere model',
    },
    'command': {
        name: 'Command',
        inputPricePer1M: 1.00,
        outputPricePer1M: 2.00,
        contextWindow: 4096,
        description: 'Legacy Command model',
    },
    'command-light': {
        name: 'Command Light',
        inputPricePer1M: 0.30,
        outputPricePer1M: 0.60,
        contextWindow: 4096,
        description: 'Fast Command variant',
    },
    'embed-english-v3.0': {
        name: 'Embed English v3',
        inputPricePer1M: 0.10,
        outputPricePer1M: 0.00,
        contextWindow: 512,
        description: 'English embeddings',
    },
    'embed-multilingual-v3.0': {
        name: 'Embed Multilingual v3',
        inputPricePer1M: 0.10,
        outputPricePer1M: 0.00,
        contextWindow: 512,
        description: 'Multilingual embeddings',
    },

    // ==================== DeepSeek Models ====================
    'deepseek-chat': {
        name: 'DeepSeek Chat',
        inputPricePer1M: 0.14,
        outputPricePer1M: 0.28,
        contextWindow: 64000,
        description: 'Affordable Chinese model',
    },
    'deepseek-coder': {
        name: 'DeepSeek Coder',
        inputPricePer1M: 0.14,
        outputPricePer1M: 0.28,
        contextWindow: 64000,
        description: 'Coding-focused DeepSeek',
    },
    'deepseek-v3': {
        name: 'DeepSeek V3',
        inputPricePer1M: 0.27,
        outputPricePer1M: 1.10,
        contextWindow: 64000,
        description: 'Latest DeepSeek model',
    },
    'deepseek-v2.5': {
        name: 'DeepSeek V2.5',
        inputPricePer1M: 0.14,
        outputPricePer1M: 0.28,
        contextWindow: 64000,
        description: 'Stable DeepSeek version',
    },

    // ==================== Alibaba Qwen Models ====================
    'qwen-max': {
        name: 'Qwen Max',
        inputPricePer1M: 2.40,
        outputPricePer1M: 2.40,
        contextWindow: 32000,
        description: 'Most capable Qwen',
    },
    'qwen-plus': {
        name: 'Qwen Plus',
        inputPricePer1M: 0.80,
        outputPricePer1M: 0.80,
        contextWindow: 131072,
        description: 'Balanced Qwen model',
    },
    'qwen-turbo': {
        name: 'Qwen Turbo',
        inputPricePer1M: 0.28,
        outputPricePer1M: 0.28,
        contextWindow: 131072,
        description: 'Fast Qwen model',
    },
    'qwen-2.5-72b': {
        name: 'Qwen 2.5 72B',
        inputPricePer1M: 0.90,
        outputPricePer1M: 0.90,
        contextWindow: 131072,
        description: 'Large Qwen 2.5',
    },
    'qwen-2.5-coder-32b': {
        name: 'Qwen 2.5 Coder 32B',
        inputPricePer1M: 0.60,
        outputPricePer1M: 0.60,
        contextWindow: 131072,
        description: 'Coding-focused Qwen',
    },
    'qwq-32b-preview': {
        name: 'QwQ 32B Preview',
        inputPricePer1M: 0.60,
        outputPricePer1M: 0.60,
        contextWindow: 32000,
        description: 'Reasoning Qwen model',
    },
    'qwen-vl-max': {
        name: 'Qwen VL Max',
        inputPricePer1M: 3.00,
        outputPricePer1M: 3.00,
        contextWindow: 32000,
        description: 'Multimodal Qwen',
    },

    // ==================== xAI Grok Models ====================
    'grok-2': {
        name: 'Grok 2',
        inputPricePer1M: 2.00,
        outputPricePer1M: 10.00,
        contextWindow: 131072,
        description: 'xAI flagship model',
    },
    'grok-2-vision-1212': {
        name: 'Grok 2 Vision',
        inputPricePer1M: 2.00,
        outputPricePer1M: 10.00,
        contextWindow: 32768,
        description: 'Multimodal Grok',
    },
    'grok-beta': {
        name: 'Grok Beta',
        inputPricePer1M: 5.00,
        outputPricePer1M: 15.00,
        contextWindow: 131072,
        description: 'Grok beta version',
    },

    // ==================== Amazon Models ====================
    'amazon-titan-text-express': {
        name: 'Titan Text Express',
        inputPricePer1M: 0.20,
        outputPricePer1M: 0.60,
        contextWindow: 8192,
        description: 'Fast Amazon model',
    },
    'amazon-titan-text-lite': {
        name: 'Titan Text Lite',
        inputPricePer1M: 0.15,
        outputPricePer1M: 0.20,
        contextWindow: 4096,
        description: 'Lightweight Amazon model',
    },
    'amazon-titan-text-premier': {
        name: 'Titan Text Premier',
        inputPricePer1M: 0.50,
        outputPricePer1M: 1.50,
        contextWindow: 32000,
        description: 'Most capable Titan',
    },
    'amazon-nova-pro': {
        name: 'Amazon Nova Pro',
        inputPricePer1M: 0.80,
        outputPricePer1M: 3.20,
        contextWindow: 300000,
        description: 'Capable Nova model',
    },
    'amazon-nova-lite': {
        name: 'Amazon Nova Lite',
        inputPricePer1M: 0.06,
        outputPricePer1M: 0.24,
        contextWindow: 300000,
        description: 'Fast Nova model',
    },
    'amazon-nova-micro': {
        name: 'Amazon Nova Micro',
        inputPricePer1M: 0.035,
        outputPricePer1M: 0.14,
        contextWindow: 128000,
        description: 'Cheapest Nova model',
    },

    // ==================== AI21 Models ====================
    'jamba-1.5-large': {
        name: 'Jamba 1.5 Large',
        inputPricePer1M: 2.00,
        outputPricePer1M: 8.00,
        contextWindow: 256000,
        description: 'Large hybrid model',
    },
    'jamba-1.5-mini': {
        name: 'Jamba 1.5 Mini',
        inputPricePer1M: 0.20,
        outputPricePer1M: 0.40,
        contextWindow: 256000,
        description: 'Efficient hybrid model',
    },
    'j2-ultra': {
        name: 'Jurassic-2 Ultra',
        inputPricePer1M: 15.00,
        outputPricePer1M: 15.00,
        contextWindow: 8192,
        description: 'Legacy AI21 model',
    },
    'j2-mid': {
        name: 'Jurassic-2 Mid',
        inputPricePer1M: 10.00,
        outputPricePer1M: 10.00,
        contextWindow: 8192,
        description: 'Legacy AI21 model',
    },

    // ==================== Perplexity Models ====================
    'llama-3.1-sonar-large-128k-online': {
        name: 'Sonar Large Online',
        inputPricePer1M: 1.00,
        outputPricePer1M: 1.00,
        contextWindow: 128000,
        description: 'Large online search model',
    },
    'llama-3.1-sonar-small-128k-online': {
        name: 'Sonar Small Online',
        inputPricePer1M: 0.20,
        outputPricePer1M: 0.20,
        contextWindow: 128000,
        description: 'Small online search model',
    },
    'llama-3.1-sonar-huge-128k-online': {
        name: 'Sonar Huge Online',
        inputPricePer1M: 5.00,
        outputPricePer1M: 5.00,
        contextWindow: 128000,
        description: 'Huge online search model',
    },

    // ==================== Yi (01.AI) Models ====================
    'yi-large': {
        name: 'Yi Large',
        inputPricePer1M: 3.00,
        outputPricePer1M: 3.00,
        contextWindow: 32000,
        description: 'Large Yi model',
    },
    'yi-medium': {
        name: 'Yi Medium',
        inputPricePer1M: 1.25,
        outputPricePer1M: 1.25,
        contextWindow: 16384,
        description: 'Medium Yi model',
    },
    'yi-34b': {
        name: 'Yi 34B',
        inputPricePer1M: 0.80,
        outputPricePer1M: 0.80,
        contextWindow: 4096,
        description: 'Open-source Yi 34B',
    },

    // ==================== Zhipu/GLM Models ====================
    'glm-4': {
        name: 'GLM-4',
        inputPricePer1M: 1.40,
        outputPricePer1M: 1.40,
        contextWindow: 128000,
        description: 'Zhipu flagship model',
    },
    'glm-4-plus': {
        name: 'GLM-4 Plus',
        inputPricePer1M: 7.00,
        outputPricePer1M: 7.00,
        contextWindow: 128000,
        description: 'Most capable GLM',
    },
    'glm-4v': {
        name: 'GLM-4V',
        inputPricePer1M: 7.00,
        outputPricePer1M: 7.00,
        contextWindow: 2048,
        description: 'Multimodal GLM',
    },

    // ==================== Inflection Models ====================
    'inflection-3': {
        name: 'Inflection 3',
        inputPricePer1M: 0.80,
        outputPricePer1M: 0.80,
        contextWindow: 8192,
        description: 'Latest Inflection model',
    },
    'inflection-2.5': {
        name: 'Inflection 2.5',
        inputPricePer1M: 0.50,
        outputPricePer1M: 0.50,
        contextWindow: 8192,
        description: 'Balanced Inflection model',
    },
};

export interface CostResult {
    model: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    inputCost: number;
    outputCost: number;
    totalCost: number;
    currency: string;
    pricing: ModelPricing;
}

/**
 * Tính chi phí cho một request
 */
export function calculateCost(
    model: string,
    inputTokens: number,
    outputTokens: number
): CostResult {
    // Tìm pricing phù hợp
    let pricing = MODEL_PRICING[model.toLowerCase()];

    if (!pricing) {
        // Thử tìm theo prefix
        for (const [key, value] of Object.entries(MODEL_PRICING)) {
            if (model.toLowerCase().includes(key.toLowerCase())) {
                pricing = value;
                break;
            }
        }
    }

    // Default pricing nếu không tìm thấy
    if (!pricing) {
        pricing = {
            name: model,
            inputPricePer1M: 1.00,
            outputPricePer1M: 2.00,
            contextWindow: 8192,
            description: 'Unknown model - using default pricing',
        };
    }

    const inputCost = (inputTokens / 1_000_000) * pricing.inputPricePer1M;
    const outputCost = (outputTokens / 1_000_000) * pricing.outputPricePer1M;
    const totalCost = inputCost + outputCost;

    return {
        model,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        inputCost: Math.round(inputCost * 1_000_000) / 1_000_000, // 6 decimal places
        outputCost: Math.round(outputCost * 1_000_000) / 1_000_000,
        totalCost: Math.round(totalCost * 1_000_000) / 1_000_000,
        currency: 'USD',
        pricing,
    };
}

/**
 * So sánh chi phí giữa các models
 */
export function compareCosts(
    inputTokens: number,
    outputTokens: number,
    models?: string[]
): CostResult[] {
    const modelsToCompare = models || Object.keys(MODEL_PRICING);

    return modelsToCompare
        .map(model => calculateCost(model, inputTokens, outputTokens))
        .sort((a, b) => a.totalCost - b.totalCost);
}

/**
 * Lấy danh sách models và pricing
 */
export function getAvailableModels(): ModelPricing[] {
    return Object.values(MODEL_PRICING).sort((a, b) =>
        a.inputPricePer1M - b.inputPricePer1M
    );
}

/**
 * Ước tính chi phí cho một dự án
 */
export function estimateProjectCost(
    model: string,
    dailyInputTokens: number,
    dailyOutputTokens: number,
    days: number = 30
): {
    daily: CostResult;
    monthly: CostResult;
    projected: CostResult;
} {
    const daily = calculateCost(model, dailyInputTokens, dailyOutputTokens);
    const monthly = calculateCost(model, dailyInputTokens * 30, dailyOutputTokens * 30);
    const projected = calculateCost(model, dailyInputTokens * days, dailyOutputTokens * days);

    return { daily, monthly, projected };
}
