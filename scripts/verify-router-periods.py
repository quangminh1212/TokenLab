#!/usr/bin/env python3
"""Reconcile raw 9router jsonl buckets vs expected XLab Token period filters."""
from __future__ import annotations

import json
from datetime import datetime, timezone, timedelta
from pathlib import Path

p = Path.home() / "AppData/Roaming/xlab-token/mirrors/9router/usage-history.jsonl"
now = datetime.now(timezone.utc)
local_midnight = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc)

cuts = {
    "today": local_midnight,
    "24h": now - timedelta(hours=24),
    "7d": now - timedelta(days=7),
    "30d": now - timedelta(days=30),
    "all": datetime(1970, 1, 1, tzinfo=timezone.utc),
}

rows = []
with p.open(encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        r = json.loads(line)
        ts = datetime.fromisoformat(r["timestamp"].replace("Z", "+00:00"))
        pt = int(r.get("promptTokens") or 0)
        ct = int(r.get("completionTokens") or 0)
        cost = float(r.get("cost") or 0)
        rows.append((ts, pt, ct, cost, r.get("model"), r.get("provider")))

print("now_utc", now.isoformat())
print("local_midnight_utc", local_midnight.isoformat())
print("total_rows", len(rows))
print("range", rows[0][0].isoformat(), "->", rows[-1][0].isoformat())

for name, cut in cuts.items():
    sub = [r for r in rows if r[0] >= cut]
    events = len(sub)
    tokens = sum(r[1] + r[2] for r in sub)
    cost = sum(r[3] for r in sub)
    print(f"{name:6} events={events:7d}  tokens={tokens:15d}  cost=${cost:12.4f}")

# last 10 days daily
print("\nby day (last 12):")
by = {}
for ts, pt, ct, cost, model, prov in rows:
    d = ts.date().isoformat()
    b = by.setdefault(d, {"n": 0, "tok": 0, "cost": 0.0})
    b["n"] += 1
    b["tok"] += pt + ct
    b["cost"] += cost
for d in sorted(by)[-12:]:
    b = by[d]
    print(f"  {d}  n={b['n']:5d}  tok={b['tok']:12d}  cost=${b['cost']:.4f}")
