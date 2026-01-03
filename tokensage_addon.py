"""
TokenSage mitmproxy Addon
Intercepts LLM API traffic and sends data to TokenSage for storage
"""

import json
import re
import urllib.request
import urllib.error
from datetime import datetime
from mitmproxy import http, ctx
from pathlib import Path
from threading import Thread

# TokenSage API endpoint
TOKENSAGE_URL = "http://localhost:4000/ingest"

# Local backup log
LOG_DIR = Path(__file__).parent / "data"
LOG_FILE = LOG_DIR / "mitmproxy_usage.json"

# LLM API patterns to intercept - COMPREHENSIVE LIST
LLM_PATTERNS = [
    # ==================== AI IDEs ====================
    # Antigravity (Google DeepMind AI IDE)
    r"antigravity\.google",
    r".*\.antigravity\.google",
    r"api\.antigravity\.google",
    # Cursor AI
    r"api2\.cursor\.sh",
    r"api\.cursor\.so",
    r"cursor\.sh",
    r".*\.cursor\.sh",
    r".*cursor.*\.com",
    # Windsurf/Codeium
    r"server\.codeium\.com",
    r"api\.codeium\.com",
    r"windsurf\.com",
    r".*\.codeium\.com",
    r".*\.windsurf\.com",
    # Kiro (AWS) - uses Bedrock
    r"kiro\.dev",
    r".*\.kiro\.dev",
    r"kiro.*\.amazonaws\.com",
    r".*kiro.*",
    # Zed AI
    r".*\.zed\.dev",
    r"api\.zed\.dev",
    # Tabnine
    r".*\.tabnine\.com",
    r"api\.tabnine\.com",
    # Sourcegraph Cody
    r".*\.sourcegraph\.com",
    r"cody\.sourcegraph\.com",
    # JetBrains AI
    r".*\.jetbrains\.com",
    r"ai\.jetbrains\.com",
    # Replit AI
    r".*\.replit\.com",
    r"api\.replit\.com",
    # Continue.dev
    r".*\.continue\.dev",
    
    # ==================== Major LLM Providers ====================
    # OpenAI
    r"api\.openai\.com",
    r".*\.openai\.com",
    # Anthropic / Claude
    r"api\.anthropic\.com",
    r"claude\.ai",
    r".*\.anthropic\.com",
    r".*\.claude\.ai",
    # Google/Gemini
    r"generativelanguage\.googleapis\.com",
    r"aiplatform\.googleapis\.com",
    r".*\.googleapis\.com.*gemini",
    r".*\.googleapis\.com.*bard",
    r"aistudio\.google\.com",
    # Azure OpenAI
    r".*\.openai\.azure\.com",
    r".*\.cognitiveservices\.azure\.com",
    # GitHub Copilot
    r"api\.github\.com",
    r"copilot.*\.githubusercontent\.com",
    r"githubcopilot\.com",
    r".*\.githubcopilot\.com",
    r"api\.githubcopilot\.com",
    # Amazon Bedrock / Q Developer
    r"bedrock.*\.amazonaws\.com",
    r"bedrock-runtime.*\.amazonaws\.com",
    r"q\..*\.amazonaws\.com",
    r"codewhisperer.*\.amazonaws\.com",
    r".*\.bedrock\..*\.amazonaws\.com",
    r".*bedrock-runtime.*",
    
    # ==================== Other LLM Providers ====================
    r"api\.cohere\.ai",
    r"api\.cohere\.com",
    r"api\.mistral\.ai",
    r".*\.mistral\.ai",
    r"api\.deepseek\.com",
    r".*\.deepseek\.com",
    r"api\.together\.xyz",
    r"api\.together\.ai",
    r".*\.together\.ai",
    r"api\.groq\.com",
    r".*\.groq\.com",
    r"api\.perplexity\.ai",
    r".*\.perplexity\.ai",
    r"api\.replicate\.com",
    r".*\.replicate\.com",
    r"api\.fireworks\.ai",
    r".*\.fireworks\.ai",
    r"api\.anyscale\.com",
    r".*\.anyscale\.com",
    r"api\.huggingface\.co",
    r".*\.huggingface\.co",
    r"inference\.huggingface\.co",
    r"api-inference\.huggingface\.co",
    r"api\.cerebras\.ai",
    r".*\.cerebras\.ai",
    r"api\.sambanova\.ai",
    r".*\.sambanova\.ai",
    r"api\.ai21\.com",
    r".*\.ai21\.com",
    r"api\.aleph-alpha\.com",
    r".*\.aleph-alpha\.com",
    r"api\.nlpcloud\.io",
    r".*\.nlpcloud\.io",
    r"api\.lepton\.ai",
    r".*\.lepton\.ai",
    r"api\.modal\.com",
    r".*\.modal\.com",
    r"api\.runpod\.ai",
    r".*\.runpod\.ai",
    r"api\.baseten\.co",
    r".*\.baseten\.co",
    r"api\.banana\.dev",
    r".*\.banana\.dev",
    r"api\.octoai\.cloud",
    r".*\.octoai\.cloud",
    r"api\.lambdalabs\.com",
    r".*\.lambdalabs\.com",
    r"api\.moonshot\.cn",
    r".*\.moonshot\.cn",
    r"api\.baichuan-ai\.com",
    r".*\.baichuan-ai\.com",
    r"api\.zhipuai\.cn",
    r".*\.zhipuai\.cn",
    r"api\.minimax\.chat",
    r".*\.minimax\.chat",
    r"api\.xai\.com",
    r".*\.x\.ai",
    r"api\.x\.ai",
    # Ollama (local)
    r"localhost:11434",
    r"127\.0\.0\.1:11434",
    # LM Studio (local)
    r"localhost:1234",
    r"127\.0\.0\.1:1234",
]

# Compiled patterns
PATTERNS = [re.compile(p) for p in LLM_PATTERNS]


def send_to_tokensage(data: dict):
    """Send usage data to TokenSage API (non-blocking)"""
    def _send():
        try:
            req = urllib.request.Request(
                TOKENSAGE_URL,
                data=json.dumps(data).encode('utf-8'),
                headers={'Content-Type': 'application/json'},
                method='POST'
            )
            with urllib.request.urlopen(req, timeout=5) as response:
                result = json.loads(response.read().decode('utf-8'))
                if result.get('success'):
                    ctx.log.info(f"✅ Sent to TokenSage: {data.get('model')} | {data.get('input_tokens')}+{data.get('output_tokens')} tokens")
        except urllib.error.URLError as e:
            ctx.log.warn(f"⚠️ TokenSage unavailable: {e.reason}")
        except Exception as e:
            ctx.log.error(f"❌ Failed to send to TokenSage: {e}")
    
    # Run in background thread to not block mitmproxy
    Thread(target=_send, daemon=True).start()


class TokenSageAddon:
    def __init__(self):
        self.usage_log = []
        self.load_existing_log()
        ctx.log.info("🔮 TokenSage Addon initialized")
        ctx.log.info(f"📡 Sending data to: {TOKENSAGE_URL}")
    
    def load_existing_log(self):
        """Load existing usage log from file"""
        try:
            if LOG_FILE.exists():
                with open(LOG_FILE, 'r') as f:
                    self.usage_log = json.load(f)
                ctx.log.info(f"📂 Loaded {len(self.usage_log)} existing records")
        except Exception as e:
            ctx.log.error(f"Failed to load log: {e}")
            self.usage_log = []
    
    def save_log(self):
        """Save usage log to file (backup)"""
        try:
            LOG_DIR.mkdir(parents=True, exist_ok=True)
            with open(LOG_FILE, 'w') as f:
                json.dump(self.usage_log[-1000:], f, indent=2)
        except Exception as e:
            ctx.log.error(f"Failed to save log: {e}")
    
    def is_llm_request(self, host: str) -> bool:
        """Check if request is to an LLM API"""
        return any(p.search(host) for p in PATTERNS)
    
    def extract_model_from_request(self, request_body: bytes, host: str, path: str = "") -> str:
        """Extract model from request body or URL path"""
        model = "unknown"
        
        # Try to extract from URL path first (Bedrock format: /model/{modelId}/invoke)
        if path:
            # Bedrock: /model/anthropic.claude-3-5-sonnet-20241022-v2:0/invoke
            bedrock_match = re.search(r'/model/([^/]+)/(invoke|converse)', path)
            if bedrock_match:
                model = bedrock_match.group(1)
                return model
            
            # Google: /v1/models/{model}:generateContent
            google_match = re.search(r'/models/([^/:]+)', path)
            if google_match:
                model = google_match.group(1)
                return model
        
        # Try to extract from request body
        try:
            data = json.loads(request_body.decode('utf-8', errors='ignore'))
            model = data.get('model', data.get('modelId', model))
        except:
            pass
        
        return model
    
    def extract_tokens(self, response_body: str, host: str) -> dict:
        """Extract token usage from response body"""
        tokens = {
            "input_tokens": 0,
            "output_tokens": 0,
            "total_tokens": 0,
            "model": "unknown"
        }
        
        try:
            # Handle streaming responses (multiple JSON objects)
            if response_body.startswith('data:') or '\ndata:' in response_body:
                # SSE streaming format
                for line in response_body.split('\n'):
                    if line.startswith('data:') and '[DONE]' not in line:
                        try:
                            data = json.loads(line[5:].strip())
                            if "usage" in data:
                                usage = data["usage"]
                                tokens["input_tokens"] = usage.get("prompt_tokens", usage.get("input_tokens", tokens["input_tokens"]))
                                tokens["output_tokens"] = usage.get("completion_tokens", usage.get("output_tokens", tokens["output_tokens"]))
                            if "model" in data:
                                tokens["model"] = data["model"]
                            # Bedrock streaming metrics
                            if "amazon-bedrock-invocationMetrics" in data:
                                metrics = data["amazon-bedrock-invocationMetrics"]
                                tokens["input_tokens"] = metrics.get("inputTokenCount", tokens["input_tokens"])
                                tokens["output_tokens"] = metrics.get("outputTokenCount", tokens["output_tokens"])
                        except:
                            pass
                tokens["total_tokens"] = tokens["input_tokens"] + tokens["output_tokens"]
                return tokens
            
            data = json.loads(response_body)
            
            # OpenAI format
            if "usage" in data:
                usage = data["usage"]
                tokens["input_tokens"] = usage.get("prompt_tokens", usage.get("input_tokens", 0))
                tokens["output_tokens"] = usage.get("completion_tokens", usage.get("output_tokens", 0))
                tokens["total_tokens"] = usage.get("total_tokens", 
                    tokens["input_tokens"] + tokens["output_tokens"])
            
            # Anthropic format
            if "usage" in data and "input_tokens" in data.get("usage", {}):
                usage = data["usage"]
                tokens["input_tokens"] = usage.get("input_tokens", 0)
                tokens["output_tokens"] = usage.get("output_tokens", 0)
                tokens["total_tokens"] = tokens["input_tokens"] + tokens["output_tokens"]
            
            # Amazon Bedrock format
            if "amazon-bedrock-invocationMetrics" in data:
                metrics = data["amazon-bedrock-invocationMetrics"]
                tokens["input_tokens"] = metrics.get("inputTokenCount", 0)
                tokens["output_tokens"] = metrics.get("outputTokenCount", 0)
                tokens["total_tokens"] = tokens["input_tokens"] + tokens["output_tokens"]
            
            # Bedrock Claude format
            if "inputTokenCount" in data or "outputTokenCount" in data:
                tokens["input_tokens"] = data.get("inputTokenCount", 0)
                tokens["output_tokens"] = data.get("outputTokenCount", 0)
                tokens["total_tokens"] = tokens["input_tokens"] + tokens["output_tokens"]
            
            # Google/Gemini format
            if "usageMetadata" in data:
                usage = data["usageMetadata"]
                tokens["input_tokens"] = usage.get("promptTokenCount", 0)
                tokens["output_tokens"] = usage.get("candidatesTokenCount", 0)
                tokens["total_tokens"] = usage.get("totalTokenCount", 
                    tokens["input_tokens"] + tokens["output_tokens"])
            
            # Model extraction
            if "model" in data:
                tokens["model"] = data["model"]
            elif "modelId" in data:
                tokens["model"] = data["modelId"]
            
        except json.JSONDecodeError:
            pass
        except Exception as e:
            ctx.log.error(f"Token extraction error: {e}")
        
        return tokens
    
    def request(self, flow: http.HTTPFlow):
        """Called when a request is made - store model info"""
        if not self.is_llm_request(flow.request.host):
            return
        
        # Store model from request for later use
        if flow.request.content:
            model = self.extract_model_from_request(flow.request.content, flow.request.host, flow.request.path)
            flow.metadata['tokensage_model'] = model
    
    def response(self, flow: http.HTTPFlow):
        """Called when a response is received"""
        host = flow.request.host
        
        if not self.is_llm_request(host):
            return
        
        # Get model from request metadata or response
        request_model = flow.metadata.get('tokensage_model', 'unknown')
        
        # Log the request
        record = {
            "timestamp": datetime.now().isoformat(),
            "host": host,
            "path": flow.request.path,
            "method": flow.request.method,
            "status_code": flow.response.status_code,
            "content_type": flow.response.headers.get("content-type", ""),
            "request_id": f"mitm_{datetime.now().strftime('%Y%m%d%H%M%S')}_{id(flow)}",
        }
        
        # Try to extract token usage from response
        if flow.response.content:
            try:
                body = flow.response.content.decode('utf-8', errors='ignore')
                tokens = self.extract_tokens(body, host)
                
                # Use model from request if not in response
                if tokens["model"] == "unknown":
                    tokens["model"] = request_model
                
                record.update(tokens)
                
                if tokens["total_tokens"] > 0:
                    ctx.log.info(
                        f"🔮 {host} | {tokens['model']} | "
                        f"{tokens['input_tokens']}+{tokens['output_tokens']} = {tokens['total_tokens']} tokens"
                    )
                    
                    # Send to TokenSage API
                    send_to_tokensage({
                        "model": tokens["model"],
                        "input_tokens": tokens["input_tokens"],
                        "output_tokens": tokens["output_tokens"],
                        "host": host,
                        "path": flow.request.path,
                        "request_id": record["request_id"],
                        "status_code": flow.response.status_code,
                    })
                    
            except Exception as e:
                ctx.log.error(f"Response parsing error: {e}")
        
        # Add to local log (backup)
        self.usage_log.append(record)
        self.save_log()


addons = [TokenSageAddon()]
