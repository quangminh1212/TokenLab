"""
TokenSage mitmproxy Addon
Intercepts and logs all LLM API traffic including gRPC
"""

import json
import re
from datetime import datetime
from mitmproxy import http, ctx
from pathlib import Path

# Log file
LOG_DIR = Path(__file__).parent / "data"
LOG_FILE = LOG_DIR / "mitmproxy_usage.json"

# LLM API patterns to intercept
LLM_PATTERNS = [
    # Cursor AI
    r"api2\.cursor\.sh",
    r"api\.cursor\.so",
    # OpenAI
    r"api\.openai\.com",
    # Anthropic
    r"api\.anthropic\.com",
    # Google/Gemini
    r"generativelanguage\.googleapis\.com",
    r"aiplatform\.googleapis\.com",
    # Azure OpenAI
    r"\.openai\.azure\.com",
    # Other LLM providers
    r"api\.cohere\.ai",
    r"api\.mistral\.ai",
]

# Compiled patterns
PATTERNS = [re.compile(p) for p in LLM_PATTERNS]

class TokenSageAddon:
    def __init__(self):
        self.usage_log = []
        self.load_existing_log()
    
    def load_existing_log(self):
        """Load existing usage log from file"""
        try:
            if LOG_FILE.exists():
                with open(LOG_FILE, 'r') as f:
                    self.usage_log = json.load(f)
                ctx.log.info(f"Loaded {len(self.usage_log)} existing records")
        except Exception as e:
            ctx.log.error(f"Failed to load log: {e}")
            self.usage_log = []
    
    def save_log(self):
        """Save usage log to file"""
        try:
            LOG_DIR.mkdir(parents=True, exist_ok=True)
            with open(LOG_FILE, 'w') as f:
                json.dump(self.usage_log[-1000:], f, indent=2)  # Keep last 1000
        except Exception as e:
            ctx.log.error(f"Failed to save log: {e}")
    
    def is_llm_request(self, host: str) -> bool:
        """Check if request is to an LLM API"""
        return any(p.search(host) for p in PATTERNS)
    
    def extract_tokens(self, response_body: str, host: str) -> dict:
        """Extract token usage from response body"""
        tokens = {
            "input_tokens": 0,
            "output_tokens": 0,
            "total_tokens": 0,
            "model": "unknown"
        }
        
        try:
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
            
        except json.JSONDecodeError:
            pass
        except Exception as e:
            ctx.log.error(f"Token extraction error: {e}")
        
        return tokens
    
    def response(self, flow: http.HTTPFlow):
        """Called when a response is received"""
        host = flow.request.host
        
        if not self.is_llm_request(host):
            return
        
        # Log the request
        record = {
            "timestamp": datetime.now().isoformat(),
            "host": host,
            "path": flow.request.path,
            "method": flow.request.method,
            "status_code": flow.response.status_code,
            "content_type": flow.response.headers.get("content-type", ""),
        }
        
        # Try to extract token usage from response
        if flow.response.content:
            try:
                body = flow.response.content.decode('utf-8', errors='ignore')
                tokens = self.extract_tokens(body, host)
                record.update(tokens)
                
                if tokens["total_tokens"] > 0:
                    ctx.log.info(
                        f"🔮 TokenSage: {host} | "
                        f"{tokens['model']} | "
                        f"{tokens['input_tokens']}+{tokens['output_tokens']} tokens"
                    )
            except Exception as e:
                ctx.log.error(f"Response parsing error: {e}")
        
        # Add to log
        self.usage_log.append(record)
        self.save_log()
        
        # Print summary
        ctx.log.info(f"📝 Logged: {flow.request.method} {host}{flow.request.path[:50]}")


addons = [TokenSageAddon()]
