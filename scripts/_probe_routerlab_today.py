#!/usr/bin/env python3
"""Probe RouterLab (:1212) usage for today on VPS next to 9router."""
from __future__ import annotations

import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone

import paramiko

HOST = "36.50.26.247"
PASSWORD = os.environ.get("VPS_SSH_PASSWORD") or "a7xe$zZ#NM@2yP8X"

REMOTE = r'''
python3 - <<'PY'
import json, sqlite3, subprocess
from pathlib import Path
from collections import defaultdict
from datetime import datetime, timezone, timedelta

now = datetime.now(timezone.utc)
vn = now + timedelta(hours=7)
print("UTC", now.isoformat())
print("VN_DATE", vn.strftime("%Y-%m-%d"))
print("UTC_DATE", now.strftime("%Y-%m-%d"))

root = Path("/var/lib/xlabrouter")
j = json.loads((root / "db.json").read_text(encoding="utf-8", errors="ignore"))
u = j.get("usageData") or {}
daily = u.get("dailySummary") or {}
hist = u.get("history") or []
print("lifetime", u.get("totalRequestsLifetime"))
print("daily_keys", sorted(daily.keys()))
for dk in sorted(daily.keys())[-6:]:
    d = daily[dk]
    print("DAY", dk, "req", d.get("requests"), "pt", d.get("promptTokens"), "ct", d.get("completionTokens"), "cost", d.get("cost"), "models", len(d.get("byModel") or {}))

def bucket_rows(rows, ts_key="timestamp"):
    by = defaultdict(lambda: {"n": 0, "pt": 0.0, "ct": 0.0, "cost": 0.0, "models": set()})
    for row in rows:
        if not isinstance(row, dict):
            continue
        ts = str(row.get(ts_key) or row.get("createdAt") or row.get("time") or "")
        day = ts[:10]
        if len(day) != 10:
            continue
        tok = row.get("tokens") if isinstance(row.get("tokens"), dict) else {}
        pt = float(tok.get("prompt_tokens") or tok.get("promptTokens") or row.get("promptTokens") or 0)
        ct = float(tok.get("completion_tokens") or tok.get("completionTokens") or row.get("completionTokens") or 0)
        by[day]["n"] += 1
        by[day]["pt"] += pt
        by[day]["ct"] += ct
        by[day]["cost"] += float(row.get("cost") or 0)
        by[day]["models"].add(str(row.get("model") or "?"))
    return by

print("HIST", {k: {**v, "models": len(v["models"])} for k, v in sorted(bucket_rows(hist).items())[-6:]})

rd_path = root / "request-details.json"
if rd_path.is_file():
    data = json.loads(rd_path.read_text(encoding="utf-8", errors="ignore"))
    rec = data.get("records") if isinstance(data, dict) else data
    print("RD_N", len(rec) if isinstance(rec, list) else 0, "bytes", rd_path.stat().st_size)
    if isinstance(rec, list):
        print("RD", {k: {**v, "models": sorted(v["models"])[:8]} for k, v in sorted(bucket_rows(rec).items())[-6:]})

# usage.json?
for name in ("usage.json", "usageData.json", "usage-history.jsonl"):
    p = root / name
    if p.is_file():
        print("FILE", name, p.stat().st_size)

# 9router today
con = sqlite3.connect("file:/root/.9router/db/data.sqlite?mode=ro", uri=True)
for day in [vn.strftime("%Y-%m-%d"), now.strftime("%Y-%m-%d"), "2026-07-26", "2026-07-27"]:
    row = con.execute("SELECT data FROM usageDaily WHERE dateKey=?", (day,)).fetchone()
    if row:
        d = json.loads(row[0])
        print("9R_DAILY", day, "req", d.get("requests"), "pt", d.get("promptTokens"), "cost", round(float(d.get("cost") or 0), 4))
    n, pt, ct, cost = con.execute(
        "SELECT COUNT(*), COALESCE(SUM(promptTokens),0), COALESCE(SUM(completionTokens),0), COALESCE(SUM(cost),0) "
        "FROM usageHistory WHERE substr(timestamp,1,10)=?",
        (day,),
    ).fetchone()
    print("9R_HIST", day, "n", n, "pt", int(pt), "ct", int(ct), "cost", round(float(cost), 4))
con.close()

print(subprocess.check_output("ss -tlnp | grep -E '1212|20128' || true", shell=True, text=True))
# last modified of db.json
st = (root / "db.json").stat()
print("db.json mtime", datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat(), "size", st.st_size)
PY
'''


def main() -> int:
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username="root", password=PASSWORD, timeout=30, allow_agent=False, look_for_keys=False)
    _i, o, e = c.exec_command(REMOTE, timeout=60)
    print(o.read().decode("utf-8", "replace"))
    err = e.read().decode("utf-8", "replace")
    if err.strip():
        print("ERR", err[:500])
    c.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
