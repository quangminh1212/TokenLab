"""
TokenSage mitmproxy addon
Intercept all AI API requests and send to TokenSage for tracking
"""

import json
import urllib.request
from mitmproxy import http, ctx

TOKENSAGE_URL = "http://localhost:4000/ingest"

# Provider detection patterns - expanded list
PROVIDER_PATTERNS = {
    "openai": ["api.openai.com", "openai.azure.com"],
    "anthropic": ["api.anthropic.com", "claude.ai", "anthropic"],
    "google": ["generativelanguage.googleapis.com", "aiplatform.googleapis.com", "gemini"],
    "aws": ["bedrock", "amazonaws.com"],
    "azure": ["azure.com", "microsoft.com/ai", "cognitiveservices"],
    "deepseek": ["deepseek.com"],
    "mistral": ["mistral.ai"],
    "groq": ["groq.com"],
    "together": ["together.xyz", "together.ai"],
    "perplexity": ["perplexity.ai"],
    "cohere": ["cohere.ai", "cohere.com"],
    "replicate": ["replicate.com"],
    "huggingface": ["huggingface.co", "hf.co"],
    "fireworks": ["fireworks.ai"],
    "anyscale": ["anyscale.com"],
    "kiro": ["kiro", "amazon"],  # Kiro uses AWS
}

# Keywords to identify AI API calls
AI_KEYWORDS = ["chat", "completions", "messages", "generate", "inference", "predict", "embed"]

def detect_provider(host: str) -> str:
    host_lower = host.lower()
    for provider, patterns in PROVIDER_PATTERNS.items():
        for pattern in patterns:
            if pattern in host_lower:
                return provider
    return ""

def is_ai_request(host: str, path: str) -> bool:
    """Check if this looks like an AI API request"""
    provider = detect_provider(host)
    if provider:
        return True
    
    # Check path for AI-related keywords
    path_lower = path.lower()
    for keyword in AI_KEYWORDS:
        if keyword in path_lower:
            return True
    
    return False

def extract_model(body: dict) -> str:
    return body.get("model", "unknown")

def extract_usage_from_response(body: dict) -> tuple:
    """Extract input/output tokens from response"""
    input_tokens = 0
    output_tokens = 0
    
    # OpenAI format
    if "usage" in body:
        usage = body["usage"]
        input_tokens = usage.get("prompt_tokens", 0) or usage.get("input_tokens", 0)
        output_tokens = usage.get("completion_tokens", 0) or usage.get("output_tokens", 0)
    
    # Google format
    if "usageMetadata" in body:
        usage = body["usageMetadata"]
        input_tokens = usage.get("promptTokenCount", 0)
        output_tokens = usage.get("candidatesTokenCount", 0)
    
    return input_tokens, output_tokens

def send_to_tokensage(data: dict):
    """Send usage data to TokenSage"""
    try:
        req = urllib.request.Request(
            TOKENSAGE_URL,
            data=json.dumps(data).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        urllib.request.urlopen(req, timeout=2)
    except Exception as e:
        ctx.log.warn(f"TokenSage send error: {e}")

class TokenSageAddon:
    def __init__(self):
        self.pending_requests = {}
        self.seen_hosts = set()
    
    def request(self, flow: http.HTTPFlow):
        """Capture request data"""
        host = flow.request.host
        path = flow.request.path
        
        # Log new hosts for debugging
        if host not in self.seen_hosts:
            self.seen_hosts.add(host)
            ctx.log.info(f"[TokenSage] New host: {host}")
        
        # Check if this is an AI API request
        if not is_ai_request(host, path):
            return
        
        ctx.log.info(f"[TokenSage] AI Request detected: {host}{path}")
        
        try:
            body = json.loads(flow.request.content) if flow.request.content else {}
            self.pending_requests[flow.id] = {
                "host": host,
                "path": path,
                "model": extract_model(body),
                "provider": detect_provider(host) or "unknown",
                "request_body": body
            }
        except Exception as e:
            ctx.log.warn(f"[TokenSage] Parse request error: {e}")
    
    def response(self, flow: http.HTTPFlow):
        """Process response and extract usage"""
        if flow.id not in self.pending_requests:
            return
        
        req_data = self.pending_requests.pop(flow.id)
        
        try:
            # Skip if no content or content is binary/non-JSON
            if not flow.response.content:
                return
            
            # Try to decode as UTF-8 first
            try:
                content_str = flow.response.content.decode('utf-8')
            except UnicodeDecodeError:
                # Skip binary responses
                ctx.log.debug(f"[TokenSage] Skipping binary response from {req_data['host']}")
                return
            
            # Skip if not JSON
            content_type = flow.response.headers.get("content-type", "")
            if "json" not in content_type.lower() and not content_str.strip().startswith("{"):
                return
            
            response_body = json.loads(content_str)
            input_tokens, output_tokens = extract_usage_from_response(response_body)
            
            # Get model from response if available
            model = response_body.get("model", req_data["model"])
            
            if input_tokens > 0 or output_tokens > 0:
                data = {
                    "model": model,
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "host": req_data["host"],
                    "path": req_data["path"],
                    "provider": req_data["provider"],
                    "status_code": flow.response.status_code,
                    "request_id": f"mitm_{flow.id}"
                }
                send_to_tokensage(data)
                ctx.log.info(f"[TokenSage] ✓ {model} | {input_tokens}+{output_tokens} tokens")
            else:
                ctx.log.info(f"[TokenSage] Response has no usage info: {req_data['host']}")
        except json.JSONDecodeError:
            # Not a JSON response, skip silently
            pass
        except Exception as e:
            ctx.log.warn(f"[TokenSage] Process response error: {e}")

addons = [TokenSageAddon()]
