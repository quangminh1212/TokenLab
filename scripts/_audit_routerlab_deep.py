#!/usr/bin/env python3
"""Deep audit: RouterLab request-details, backups, 9router-sync imports."""
from __future__ import annotations

import json
import os
import sys

import paramiko

HOST = "36.50.26.247"
PASSWORD = os.environ.get("VPS_SSH_PASSWORD") or "a7xe$zZ#NM@2yP8X"

REMOTE = r'''
python3 - <<'PY'
import json, os
from pathlib import Path
from collections import defaultdict
from datetime import datetime

root = Path("/var/lib/xlabrouter")

# --- live usageData ---
j = json.loads((root/"db.json").read_text(encoding="utf-8", errors="ignore"))
u = j.get("usageData") or {}
daily = u.get("dailySummary") or {}
print("LIVE_DAILY_DAYS", sorted(daily.keys()))
for dk in sorted(daily.keys()):
    d=daily[dk]
    print(" DAY", dk, "req", d.get("requests"), "pt", d.get("promptTokens"), "ct", d.get("completionTokens"), "cost", d.get("cost"), "models", len(d.get("byModel") or {}))

# --- request-details.json ---
rd = root/"request-details.json"
print("\nRD_FILE", rd.exists(), rd.stat().st_size if rd.exists() else 0)
if rd.exists():
    data = json.loads(rd.read_text(encoding="utf-8", errors="ignore"))
    print("RD_TYPE", type(data).__name__, "keys", list(data.keys())[:20] if isinstance(data, dict) else "list")
    rec = data.get("records") if isinstance(data, dict) else data
    if not isinstance(rec, list):
        rec = []
    print("RD_N", len(rec))
    by_day = defaultdict(lambda: {"n":0,"pt":0,"ct":0,"cost":0.0})
    models=defaultdict(int)
    min_ts=max_ts=None
    for row in rec:
        if not isinstance(row, dict): continue
        ts = row.get("timestamp") or row.get("createdAt") or row.get("time") or ""
        day = str(ts)[:10]
        if len(day)==10:
            by_day[day]["n"] += 1
            tok = row.get("tokens") if isinstance(row.get("tokens"), dict) else {}
            pt = float(tok.get("prompt_tokens") or row.get("promptTokens") or 0)
            ct = float(tok.get("completion_tokens") or row.get("completionTokens") or 0)
            by_day[day]["pt"] += pt
            by_day[day]["ct"] += ct
            by_day[day]["cost"] += float(row.get("cost") or 0)
            models[str(row.get("model") or "?")] += 1
        if ts:
            if min_ts is None or ts < min_ts: min_ts = ts
            if max_ts is None or ts > max_ts: max_ts = ts
    print("RD_RANGE", min_ts, "->", max_ts)
    print("RD_DAYS", len(by_day))
    for dk in sorted(by_day.keys())[-15:]:
        print(" ", dk, by_day[dk])
    print("RD_TOP_MODELS", sorted(models.items(), key=lambda x:-x[1])[:15])

    # compare vs daily for overlapping days
    print("\nCOMPARE_RD_vs_DAILY")
    for dk in sorted(set(by_day) | set(daily)):
        rd_n = by_day.get(dk, {}).get("n", 0)
        rd_pt = int(by_day.get(dk, {}).get("pt", 0))
        d = daily.get(dk) or {}
        print(f"  {dk}: daily_req={d.get('requests')} rd_n={rd_n} daily_pt={d.get('promptTokens')} rd_pt={rd_pt}")

# --- 9router-usage-sync-state ---
ss = root/"9router-usage-sync-state.json"
print("\nSYNC_STATE", ss.exists(), ss.stat().st_size if ss.exists() else 0)
if ss.exists():
    s = json.loads(ss.read_text(encoding="utf-8", errors="ignore"))
    print(" sync_keys", list(s.keys())[:40] if isinstance(s, dict) else type(s))
    if isinstance(s, dict):
        for k in ("lastSyncAt","lastSuccessAt","imported","totalImported","cursor","lastId","stats","summary"):
            if k in s: print(" ", k, str(s[k])[:300])
        # nested counts
        for k,v in s.items():
            if isinstance(v, (int, float, str)) and k not in ("lastSyncAt","lastSuccessAt"):
                if any(x in k.lower() for x in ("count","total","import","day","request","token")):
                    print("  meta", k, v)

# --- best backup with richest dailySummary ---
print("\nBACKUP_SCAN")
best=None
best_req=0
for p in sorted((root/"backups").rglob("db.json")) if (root/"backups").exists() else []:
    try:
        jj=json.loads(p.read_text(encoding="utf-8", errors="ignore"))
        uu=jj.get("usageData") or {}
        dd=uu.get("dailySummary") or {}
        req=sum(int((v or {}).get("requests") or 0) for v in dd.values() if isinstance(v, dict))
        days=len(dd)
        lifetime=uu.get("totalRequestsLifetime")
        if req > best_req:
            best_req=req
            best=(str(p), days, req, lifetime, sorted(dd.keys())[:3], sorted(dd.keys())[-3:] if dd else [])
        if days >= 5 or req >= 1000:
            print(" BAK", p, "days", days, "req", req, "lifetime", lifetime, "range", (min(dd), max(dd)) if dd else None)
    except Exception as e:
        print(" BAK_ERR", p, e)
print("BEST_BAK", best)

# also top-level bak files
for p in sorted(root.glob("db.json.bak*")):
    try:
        jj=json.loads(p.read_text(encoding="utf-8", errors="ignore"))
        uu=jj.get("usageData") or {}
        dd=uu.get("dailySummary") or {}
        req=sum(int((v or {}).get("requests") or 0) for v in dd.values() if isinstance(v, dict))
        print(" TOPBAK", p.name, "bytes", p.stat().st_size, "days", len(dd), "req", req, "lifetime", uu.get("totalRequestsLifetime"), "range", (min(dd), max(dd)) if dd else None)
    except Exception as e:
        print(" TOPBAK_ERR", p.name, e)

# cockpitImports?
ci = u.get("cockpitImports")
print("\nCOCKPIT", type(ci).__name__, (len(ci) if hasattr(ci,'__len__') else ci))
if isinstance(ci, dict):
    print(" cockpit_keys", list(ci.keys())[:20])
elif isinstance(ci, list) and ci:
    print(" cockpit_sample", str(ci[0])[:200])

print("DONE")
PY
'''


def main() -> int:
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username="root", password=PASSWORD, timeout=30, allow_agent=False, look_for_keys=False)
    _i, o, e = c.exec_command(REMOTE, timeout=120)
    print(o.read().decode("utf-8", "replace"))
    err = e.read().decode("utf-8", "replace")
    if err.strip():
        print("ERR", err[:600])
    c.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
