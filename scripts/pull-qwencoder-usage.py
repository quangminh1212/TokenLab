#!/usr/bin/env python3
"""
Pull QwenCoder Cloud dashboard usage into TokenLab mirrors.

Auth (first match wins):
  1. env QWENCODER_ACCESS_TOKEN (JWT from browser localStorage `qwencoder_access_token`)
  2. %APPDATA%/tokenlab/mirrors/qwencoder/access_token.txt
  3. Scrape live Brave window titled QwenCoder (via cua-driver get_text)

API host: https://api.qwencoder.cloud
  GET /api/v1/dashboard/me/stats
  GET /api/v1/dashboard/me/chart
  GET /api/v1/dashboard/analysis/models/me
  GET /api/v1/auth/me

Mirror out:
  %APPDATA%/tokenlab/mirrors/qwencoder/
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

API_BASE = os.environ.get("QWENCODER_API_BASE", "https://api.qwencoder.cloud").rstrip("/")
OUT = Path(
    os.environ.get(
        "TOKENLAB_QWENCODER_DIR",
        str(Path.home() / "AppData" / "Roaming" / "tokenlab" / "mirrors" / "qwencoder"),
    )
)
PATHS = [
    "/api/v1/auth/me",
    "/api/v1/dashboard/me/stats",
    "/api/v1/dashboard/me/chart",
    "/api/v1/dashboard/analysis/models/me",
]


def load_token() -> str:
    env = (os.environ.get("QWENCODER_ACCESS_TOKEN") or "").strip()
    if env:
        return env
    for p in [
        OUT / "access_token.txt",
        Path.home() / "AppData" / "Roaming" / "tokenlab" / "qwencoder-access-token.txt",
    ]:
        if p.is_file():
            t = p.read_text(encoding="utf-8", errors="replace").strip()
            if t:
                return t
    return ""


def api_get(path: str, token: str) -> tuple[int, str]:
    req = urllib.request.Request(
        API_BASE + path,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "User-Agent": "TokenLab-QwenCoder-Pull/1.0",
            "Origin": "https://qwencoder.cloud",
            "Referer": "https://qwencoder.cloud/dashboard",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        return 0, str(e)


def pull_api(token: str) -> bool:
    OUT.mkdir(parents=True, exist_ok=True)
    ok = 0
    for path in PATHS:
        code, body = api_get(path, token)
        name = path.strip("/").replace("/", "_") + ".json"
        print(f"API {code} {path}")
        if code != 200:
            print(" ", body[:200])
            continue
        (OUT / name).write_text(body, encoding="utf-8")
        ok += 1
        try:
            j = json.loads(body)
            print("  keys", list(j.keys()) if isinstance(j, dict) else type(j).__name__)
        except Exception:
            pass
    if ok:
        (OUT / "access_token.txt").write_text(token, encoding="utf-8")
        (OUT / "pulled_at.txt").write_text(
            datetime.now(timezone.utc).isoformat(), encoding="utf-8"
        )
    return ok > 0


def parse_token_amount(s: str) -> float:
    """Parse 2394.3M / 72.7M / 1505.4M → absolute tokens."""
    s = s.strip().replace(",", "")
    m = re.fullmatch(r"([0-9]+(?:\.[0-9]+)?)\s*([KMB])?", s, re.I)
    if not m:
        return 0.0
    n = float(m.group(1))
    u = (m.group(2) or "").upper()
    if u == "K":
        return n * 1_000
    if u == "M":
        return n * 1_000_000
    if u == "B":
        return n * 1_000_000_000
    return n


def parse_int_locale(s: str) -> int:
    """17.861 or 17,861 or 17861 → int (dot as thousands when 3 fractional digits)."""
    s = s.strip()
    if re.fullmatch(r"\d{1,3}(\.\d{3})+", s):
        return int(s.replace(".", ""))
    if re.fullmatch(r"\d{1,3}(,\d{3})+", s):
        return int(s.replace(",", ""))
    try:
        return int(float(s.replace(",", "")))
    except Exception:
        return 0


def parse_dashboard_text(text: str) -> dict:
    """Parse cua-driver / accessibility text of https://qwencoder.cloud/dashboard."""
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    joined = "\n".join(lines)

    totals: dict = {}
    # TOKENS USED / 2394.3M
    m = re.search(r"TOKENS USED\s*\n\s*([0-9.,]+\s*[KMB]?)", joined, re.I)
    if m:
        totals["tokensUsed"] = parse_token_amount(m.group(1))
    m = re.search(r"SUCCESS RATE\s*\n\s*([0-9.,]+)\s*%", joined, re.I)
    if m:
        totals["successRate"] = float(m.group(1).replace(",", "."))
    m = re.search(r"REQUESTS\s*\n\s*([0-9.,]+)\s*/\s*([0-9.,]+)", joined, re.I)
    if m:
        totals["successRequests"] = parse_int_locale(m.group(1))
        totals["requests"] = parse_int_locale(m.group(2))

    # Model blocks: name, then "N requests", "P%", "X.XM"
    models = []
    # Known model id pattern
    model_re = re.compile(
        r"\n(qwen3\.7-max|qwen3\.8-max(?:-preview)?|gpt-5\.6-sol|gpt-5\.6-luna|gpt-5\.6-terra|"
        r"claude-opus-4\.8|claude-opus-5|deepseek-v4-pro|deepseek-v4-flash|"
        r"kimi-k3|kimi-2\.6|minimax-m[0-9.]+|glm-5(?:\.[0-9]+)?|step-3\.7-flash|"
        r"laguna-s-2\.1|mimo-v2\.5-pro|vip-kimi)\n"
        r"([0-9.,]+)\s*requests\n"
        r"([0-9.,]+)\s*%\n"
        r"([0-9.,]+\s*[KMB]?)",
        re.I,
    )
    for m in model_re.finditer("\n" + joined + "\n"):
        models.append(
            {
                "model": m.group(1),
                "requests": parse_int_locale(m.group(2)),
                "pct": float(m.group(3).replace(",", ".")),
                "tokens": parse_token_amount(m.group(4)),
            }
        )

    # Input/output totals if present near chart
    m = re.search(
        r"TỔNG TOKEN \(30 NGÀY\)\s*\n\s*([0-9.,]+\s*[KMB]?)",
        joined,
        re.I,
    )
    if m:
        totals["tokens30d"] = parse_token_amount(m.group(1))

    return {
        "scrapedAt": datetime.now(timezone.utc).isoformat(),
        "periodDays": 30,
        "source": "brave-dashboard-text",
        "url": "https://qwencoder.cloud/dashboard",
        "totals": totals,
        "models": models,
    }


def ensure_dashboard_tab() -> None:
    """Best-effort open dashboard in Brave so UIA text is the usage page."""
    candidates = [
        Path(os.environ.get("ProgramFiles", r"C:\Program Files"))
        / "BraveSoftware/Brave-Browser/Application/brave.exe",
        Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"))
        / "BraveSoftware/Brave-Browser/Application/brave.exe",
        Path(os.environ["LOCALAPPDATA"])
        / "BraveSoftware/Brave-Browser/Application/brave.exe",
    ]
    brave = next((p for p in candidates if p.is_file()), None)
    if not brave:
        return
    try:
        subprocess.Popen(
            [str(brave), "--new-tab", "https://qwencoder.cloud/dashboard"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        import time

        time.sleep(4)
    except Exception as e:  # noqa: BLE001
        print("open brave tab failed:", e)


def scrape_brave() -> dict | None:
    """Use cua-driver list_windows + page get_text on QwenCoder Brave window."""
    ensure_dashboard_tab()
    try:
        raw = subprocess.check_output(
            ["cua-driver", "list_windows", "{}"],
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )
    except Exception as e:  # noqa: BLE001
        print("cua-driver list_windows failed:", e)
        return None

    try:
        data = json.loads(raw.lstrip("\ufeff"))
    except Exception as e:  # noqa: BLE001
        print("list_windows json fail:", e)
        return None

    wins = data.get("windows") or data.get("_legacy_windows") or []
    best = None
    best_text = ""
    for w in wins:
        title = str(w.get("title") or "")
        if "qwen" not in title.lower():
            continue
        pid = int(w["pid"])
        wid = int(w["window_id"])
        print(f"try window pid={pid} window_id={wid} title={title[:60]}")
        try:
            proc = subprocess.run(
                ["cua-driver", "page"],
                input=json.dumps({"action": "get_text", "pid": pid, "window_id": wid}),
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=60,
                capture_output=True,
            )
            text = proc.stdout or ""
        except Exception as e:  # noqa: BLE001
            print("  get_text failed:", e)
            continue
        if "TOKENS USED" in text or "WALLET BALANCE" in text or "COMMAND DECK" in text:
            best, best_text = w, text
            break
        if len(text) > len(best_text):
            best, best_text = w, text

    if not best:
        print("No Brave window with QwenCoder title — open https://qwencoder.cloud/dashboard in Brave")
        return None

    if "TOKENS USED" not in best_text:
        print("page text missing TOKENS USED markers; len=", len(best_text))
    parsed = parse_dashboard_text(best_text)
    parsed["rawTextLen"] = len(best_text)
    return parsed


def write_scrape(parsed: dict) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    fp = OUT / "dashboard-scrape.json"
    fp.write_text(json.dumps(parsed, ensure_ascii=False, indent=2), encoding="utf-8")
    print("wrote", fp)
    models = parsed.get("models") or []
    totals = parsed.get("totals") or {}
    print(
        "models",
        len(models),
        "tokensUsed",
        totals.get("tokensUsed"),
        "requests",
        totals.get("requests"),
    )
    for m in models[:12]:
        print(
            f"  {m['model']}: tokens={m['tokens']/1e6:.1f}M req={m['requests']} pct={m.get('pct')}%"
        )
    # Do not also write usage-daily.json here — parser would double-count with scrape.

def main() -> int:
    print("OUT", OUT)
    token = load_token()
    if token:
        print("token_len", len(token), "prefix", token[:16])
        if pull_api(token):
            print("API pull OK")
            return 0
        print("API pull failed (token expired?) — trying Brave scrape")
    else:
        print("No access token — trying Brave scrape")
        print(
            "Tip: set QWENCODER_ACCESS_TOKEN to localStorage.qwencoder_access_token from the dashboard"
        )

    scraped = scrape_brave()
    if scraped and (scraped.get("models") or scraped.get("totals")):
        write_scrape(scraped)
        print("SCRAPE OK")
        return 0

    print("FAILED: need valid JWT or open logged-in Brave dashboard")
    return 1


if __name__ == "__main__":
    sys.exit(main())
