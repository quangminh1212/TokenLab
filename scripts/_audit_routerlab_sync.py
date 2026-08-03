#!/usr/bin/env python3
"""Audit remote RouterLab usage sources vs local TokenLab mirrors."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import paramiko

HOST = "36.50.26.247"
USER = "root"
PASSWORD = os.environ.get("VPS_SSH_PASSWORD") or "a7xe$zZ#NM@2yP8X"

REMOTE = r'''
python3 - <<'PY'
import json, os, sqlite3
from pathlib import Path
from collections import defaultdict

def sum_daily(daily: dict):
    req=pt=ct=cost=0.0
    for dk, v in (daily or {}).items():
        if not isinstance(v, dict): continue
        req += int(v.get("requests") or 0)
        pt += float(v.get("promptTokens") or v.get("prompt_tokens") or 0)
        ct += float(v.get("completionTokens") or v.get("completion_tokens") or 0)
        cost += float(v.get("cost") or 0)
    return {"days": len(daily or {}), "requests": int(req), "prompt": int(pt), "completion": int(ct), "cost": round(cost, 4),
            "range": [min(daily), max(daily)] if daily else None}

def sum_hist(hist: list):
    req=pt=ct=cost=0.0
    for row in hist or []:
        if not isinstance(row, dict): continue
        tok = row.get("tokens") if isinstance(row.get("tokens"), dict) else {}
        pt += float(tok.get("prompt_tokens") or tok.get("promptTokens") or row.get("promptTokens") or 0)
        ct += float(tok.get("completion_tokens") or tok.get("completionTokens") or row.get("completionTokens") or 0)
        cost += float(row.get("cost") or 0)
        req += 1
    return {"n": len(hist or []), "prompt": int(pt), "completion": int(ct), "cost": round(cost, 4)}

def inspect_dbjson(p: Path):
    if not p.is_file():
        print("MISS", p)
        return
    raw = p.read_text(encoding="utf-8", errors="ignore")
    j = json.loads(raw)
    u = j.get("usageData") or j.get("usage") or {}
    daily = u.get("dailySummary") or {}
    hist = u.get("history") or []
    print("=== db.json", p, "bytes", p.stat().st_size)
    print(" top_keys", sorted(j.keys())[:30])
    print(" usage_keys", sorted(u.keys()) if isinstance(u, dict) else type(u))
    print(" lifetime", {k: u.get(k) for k in ("totalRequestsLifetime","totalPromptTokensLifetime","totalCompletionTokensLifetime","totalCostLifetime","totalTokens") if isinstance(u, dict)})
    print(" daily", sum_daily(daily if isinstance(daily, dict) else {}))
    print(" hist", sum_hist(hist if isinstance(hist, list) else []))
    # byModel sum across days
    models=set()
    for v in (daily or {}).values():
        if isinstance(v, dict) and isinstance(v.get("byModel"), dict):
            models.update(v["byModel"].keys())
    print(" byModel_keys", len(models))

def inspect_sqlite(p: Path):
    if not p.is_file():
        print("MISS_SQL", p)
        return
    print("=== sqlite", p, "bytes", p.stat().st_size)
    con = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
    cur = con.cursor()
    tables = [r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'")]
    print(" tables", tables)
    if "usageDaily" in tables:
        daily={}
        for dk, data in cur.execute("SELECT dateKey, data FROM usageDaily"):
            try: daily[dk]=json.loads(data) if isinstance(data,str) else data
            except: pass
        print(" usageDaily", sum_daily(daily))
    if "usageHistory" in tables:
        n = cur.execute("SELECT COUNT(*) FROM usageHistory").fetchone()[0]
        row = cur.execute("SELECT COALESCE(SUM(promptTokens),0), COALESCE(SUM(completionTokens),0), COALESCE(SUM(cost),0), MIN(timestamp), MAX(timestamp) FROM usageHistory").fetchone()
        print(" usageHistory", {"n": n, "prompt": int(row[0]), "completion": int(row[1]), "cost": round(float(row[2]),4), "min": row[3], "max": row[4]})
    con.close()

# process env / ports
import subprocess
print("=== services ===")
for cmd in [
    "ss -tlnp | grep -E '1212|20128' || true",
    "systemctl cat xlabrouter 2>/dev/null | head -40 || true",
    "systemctl cat routerlab 2>/dev/null | head -20 || true",
    "ls -la /var/lib/xlabrouter 2>/dev/null | head -30 || true",
    "ls -la /root/.xlabrouter 2>/dev/null | head -20 || true",
    "find /root /var/lib -maxdepth 4 -name 'data.sqlite' 2>/dev/null | head -30",
    "find /root /var/lib -maxdepth 4 -name 'db.json' 2>/dev/null | head -30",
]:
    print("$", cmd)
    try:
        print(subprocess.check_output(cmd, shell=True, text=True, stderr=subprocess.STDOUT)[:2000])
    except Exception as e:
        print("err", e)

for p in [
    Path("/var/lib/xlabrouter/db.json"),
    Path("/root/.xlabrouter/db.json"),
    Path("/root/AppData/Roaming/xlabrouter/db.json"),
    Path("/var/lib/routerlab/db.json"),
]:
    try: inspect_dbjson(p)
    except Exception as e: print("ERR", p, e)

for p in [
    Path("/var/lib/xlabrouter/db/data.sqlite"),
    Path("/var/lib/xlabrouter/data.sqlite"),
    Path("/root/.xlabrouter/db/data.sqlite"),
    Path("/root/.9router/db/data.sqlite"),
]:
    try: inspect_sqlite(p)
    except Exception as e: print("ERR_SQL", p, e)

# request-details size
for p in [
    Path("/var/lib/xlabrouter/request-details.json"),
    Path("/var/lib/xlabrouter/usage.json"),
]:
    if p.is_file():
        print("FILE", p, p.stat().st_size)
print("DONE")
PY
'''


def local_sum(path: Path):
    if not path.is_file():
        return None
    text = path.read_text(encoding="utf-8", errors="ignore")
    if path.name.endswith(".jsonl") or path.suffix == ".jsonl":
        n = pt = ct = 0
        for line in text.splitlines():
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except Exception:
                continue
            n += 1
            tok = row.get("tokens") if isinstance(row.get("tokens"), dict) else {}
            pt += float(tok.get("prompt_tokens") or row.get("promptTokens") or 0)
            ct += float(tok.get("completion_tokens") or row.get("completionTokens") or 0)
        return {"file": str(path), "n": n, "prompt": int(pt), "completion": int(ct), "bytes": path.stat().st_size}
    data = json.loads(text)
    if path.name == "usage-daily.json":
        daily = data
        req = pt = ct = cost = 0.0
        for v in daily.values():
            if not isinstance(v, dict):
                continue
            req += int(v.get("requests") or 0)
            pt += float(v.get("promptTokens") or 0)
            ct += float(v.get("completionTokens") or 0)
            cost += float(v.get("cost") or 0)
        return {"file": str(path), "days": len(daily), "requests": int(req), "prompt": int(pt), "completion": int(ct), "cost": round(cost, 4),
                "range": [min(daily), max(daily)] if daily else None, "bytes": path.stat().st_size}
    if path.name in ("usageData.json", "db.json"):
        u = data.get("usageData") if path.name == "db.json" else data
        if not isinstance(u, dict):
            u = data if isinstance(data, dict) else {}
        daily = u.get("dailySummary") or {}
        hist = u.get("history") or []
        return {
            "file": str(path),
            "bytes": path.stat().st_size,
            "lifetime": {k: u.get(k) for k in ("totalRequestsLifetime", "totalPromptTokensLifetime", "totalCompletionTokensLifetime", "totalCostLifetime")},
            "daily_days": len(daily) if isinstance(daily, dict) else 0,
            "hist_n": len(hist) if isinstance(hist, list) else 0,
        }
    return {"file": str(path), "bytes": path.stat().st_size}


def main() -> int:
    print("=== LOCAL MIRRORS ===")
    app = Path(os.environ["APPDATA"])
    for rel in [
        "tokenlab/mirrors/routerlab/usage-daily.json",
        "tokenlab/mirrors/routerlab/usage-history.jsonl",
        "tokenlab/mirrors/routerlab/usageData.json",
        "tokenlab/mirrors/xlabrouter/usage-daily.json",
        "tokenlab/mirrors/9router/usage-daily.json",
    ]:
        p = app / rel
        print(json.dumps(local_sum(p), ensure_ascii=False))

    print("\n=== REMOTE ===")
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, password=PASSWORD, timeout=30, allow_agent=False, look_for_keys=False)
    _i, o, e = c.exec_command(REMOTE, timeout=90)
    print(o.read().decode("utf-8", "replace"))
    err = e.read().decode("utf-8", "replace")
    if err.strip():
        print("ERR", err[:800])
    c.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
