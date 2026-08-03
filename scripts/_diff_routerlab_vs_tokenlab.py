#!/usr/bin/env python3
"""Diff RouterLab remote dashboard sources vs local TokenLab mirrors/cache."""
from __future__ import annotations

import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import paramiko

HOST = "36.50.26.247"
PASSWORD = os.environ.get("VPS_SSH_PASSWORD") or "a7xe$zZ#NM@2yP8X"

REMOTE = r'''
python3 - <<'PY'
import json, urllib.request, sqlite3
from pathlib import Path
from collections import defaultdict
from datetime import datetime, timezone, timedelta

now = datetime.now(timezone.utc)
vn = (now + timedelta(hours=7)).strftime("%Y-%m-%d")
utc = now.strftime("%Y-%m-%d")
print("UTC", now.isoformat())
print("VN", vn, "UTC_DATE", utc)

root = Path("/var/lib/xlabrouter")

# 1) Live db.json usageData (what dashboard usually reads)
j = json.loads((root/"db.json").read_text(encoding="utf-8", errors="ignore"))
u = j.get("usageData") or {}
daily = u.get("dailySummary") or {}
hist = u.get("history") or []
print("=== LIVE db.json usageData ===")
print("lifetime_req", u.get("totalRequestsLifetime"))
print("daily_keys", sorted(daily.keys()))
tot_req = tot_pt = tot_ct = tot_cost = 0
for dk in sorted(daily.keys()):
    d = daily[dk]
    req = int(d.get("requests") or 0)
    pt = int(d.get("promptTokens") or 0)
    ct = int(d.get("completionTokens") or 0)
    cost = float(d.get("cost") or 0)
    tot_req += req; tot_pt += pt; tot_ct += ct; tot_cost += cost
    print(f" DAY {dk} req={req} pt={pt} ct={ct} cost={cost:.6f} models={len(d.get('byModel') or {})}")
print(f" SUM_DAILY req={tot_req} pt={tot_pt} ct={tot_ct} cost={tot_cost:.4f}")

# history ring
byh = defaultdict(lambda: {"n":0,"pt":0,"ct":0,"cost":0.0})
for row in hist:
    if not isinstance(row, dict): continue
    day = str(row.get("timestamp") or "")[:10]
    tok = row.get("tokens") if isinstance(row.get("tokens"), dict) else {}
    byh[day]["n"] += 1
    byh[day]["pt"] += float(tok.get("prompt_tokens") or row.get("promptTokens") or 0)
    byh[day]["ct"] += float(tok.get("completion_tokens") or row.get("completionTokens") or 0)
    byh[day]["cost"] += float(row.get("cost") or 0)
print("HIST", {k: dict(v) for k,v in sorted(byh.items())})

# request-details
rdp = root/"request-details.json"
if rdp.is_file():
    data = json.loads(rdp.read_text(encoding="utf-8", errors="ignore"))
    rec = data.get("records") if isinstance(data, dict) else data
    byr = defaultdict(lambda: {"n":0,"pt":0,"ct":0,"cost":0.0,"ok":0,"err":0})
    for row in (rec or []):
        if not isinstance(row, dict): continue
        day = str(row.get("timestamp") or row.get("createdAt") or "")[:10]
        tok = row.get("tokens") if isinstance(row.get("tokens"), dict) else {}
        byr[day]["n"] += 1
        byr[day]["pt"] += float(tok.get("prompt_tokens") or row.get("promptTokens") or 0)
        byr[day]["ct"] += float(tok.get("completion_tokens") or row.get("completionTokens") or 0)
        byr[day]["cost"] += float(row.get("cost") or 0)
        st = str(row.get("status") or "").lower()
        if st in ("success","ok","200"): byr[day]["ok"] += 1
        elif st: byr[day]["err"] += 1
    print("RD_BYTES", rdp.stat().st_size, "RD_N", len(rec) if isinstance(rec, list) else 0)
    print("RD", {k: dict(v) for k,v in sorted(byr.items())})

# 2) HTTP API that dashboard might call
for url in [
    "http://127.0.0.1:1212/api/usage/summary",
    "http://127.0.0.1:1212/api/usage/stats",
    "http://127.0.0.1:1212/api/usage",
    "http://127.0.0.1:1212/api/usage/history?limit=5",
    "http://127.0.0.1:1212/api/usage/chart",
    "http://127.0.0.1:1212/api/usage/providers",
    "http://127.0.0.1:1212/api/v1/models",
]:
    try:
        req = urllib.request.Request(url, headers={"Accept":"application/json"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            body = resp.read()[:800]
            print("API", resp.status, url, body[:300])
    except Exception as e:
        print("API_FAIL", url, type(e).__name__, e)

# list api routes from next if possible
print("=== files usage related ===")
for p in sorted(root.glob("*"))[:40]:
    if p.is_file() and any(x in p.name.lower() for x in ("usage","request","daily","history")):
        print(" ", p.name, p.stat().st_size)

# cockpit / imported
print("cockpitImports", type(u.get("cockpitImports")).__name__, len(u.get("cockpitImports") or []) if hasattr(u.get("cockpitImports"),"__len__") else u.get("cockpitImports"))

# 9router today for contrast
con = sqlite3.connect("file:/root/.9router/db/data.sqlite?mode=ro", uri=True)
for day in [vn, utc, "2026-07-26", "2026-07-27"]:
    row = con.execute("SELECT data FROM usageDaily WHERE dateKey=?", (day,)).fetchone()
    if not row: continue
    d = json.loads(row[0])
    print("9R", day, "req", d.get("requests"), "pt", d.get("promptTokens"), "cost", round(float(d.get("cost") or 0), 4))
con.close()
print("DONE")
PY
'''


def local_mirror_sum():
    app = Path(os.environ["APPDATA"]) / "tokenlab" / "mirrors" / "routerlab"
    daily_p = app / "usage-daily.json"
    print("\n=== LOCAL MIRROR", daily_p, "mtime", datetime.fromtimestamp(daily_p.stat().st_mtime) if daily_p.exists() else None)
    if not daily_p.exists():
        return
    daily = json.loads(daily_p.read_text(encoding="utf-8"))
    tot_req = tot_pt = tot_ct = tot_cost = 0
    for dk in sorted(daily.keys())[-8:]:
        d = daily[dk]
        req = int(d.get("requests") or 0)
        pt = int(d.get("promptTokens") or 0)
        ct = int(d.get("completionTokens") or 0)
        cost = float(d.get("cost") or 0)
        tot_req += req; tot_pt += pt; tot_ct += ct; tot_cost += cost
        print(f" DAY {dk} req={req} pt={pt} ct={ct} cost={cost:.6f}")
    # full sum
    req = sum(int(v.get("requests") or 0) for v in daily.values())
    pt = sum(int(v.get("promptTokens") or 0) for v in daily.values())
    cost = sum(float(v.get("cost") or 0) for v in daily.values())
    print(f" FULL_MIRROR days={len(daily)} req={req} pt={pt} cost={cost:.4f} range={min(daily)}..{max(daily)}")

    # request-details local
    rd = app / "request-details.jsonl"
    if rd.exists():
        by = defaultdict(int)
        for line in rd.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            r = json.loads(line)
            by[str(r.get("timestamp") or "")[:10]] += 1
        print("LOCAL_RD", dict(by))


def scan_cache_today():
    p = Path(os.environ["APPDATA"]) / "tokenlab" / "scan-cache.json"
    print("\n=== SCAN-CACHE routerlab ===")
    data = json.loads(p.read_text(encoding="utf-8"))
    vn = (datetime.now(timezone.utc) + timedelta(hours=7)).strftime("%Y-%m-%d")
    for agent in ("routerlab", "9router"):
        ev = [e for e in data if e.get("agent") == agent]
        print(f" agent {agent} total_events={len(ev)}")
        by = defaultdict(lambda: {"n": 0, "req": 0, "tok": 0, "cost": 0.0})
        for e in ev:
            day = str(e.get("timestamp") or "")[:10]
            by[day]["n"] += 1
            rc = e.get("requestCount")
            by[day]["req"] += int(rc) if isinstance(rc, (int, float)) and rc > 0 else 1
            tok = int(e.get("totalTokens") or 0) or (int(e.get("inputTokens") or 0) + int(e.get("outputTokens") or 0))
            by[day]["tok"] += tok
            by[day]["cost"] += float(e.get("estimatedCost") or 0)
        for day in sorted(by.keys())[-5:]:
            print(f"  {agent} {day}", dict(by[day]))
        # today
        t = by.get(vn) or by.get(datetime.now(timezone.utc).strftime("%Y-%m-%d"))
        print(f"  {agent} TODAY_VN={vn}", t)


def main() -> int:
    local_mirror_sum()
    scan_cache_today()
    print("\n=== REMOTE ===")
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username="root", password=PASSWORD, timeout=30, allow_agent=False, look_for_keys=False)
    _i, o, e = c.exec_command(REMOTE, timeout=90)
    print(o.read().decode("utf-8", "replace"))
    err = e.read().decode("utf-8", "replace")
    if err.strip():
        print("ERR", err[:800])
    c.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
