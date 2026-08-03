#!/usr/bin/env python3
"""Audit TokenLab scan-cache cost by agent and compare sources for drops."""
from __future__ import annotations

import json
import os
from collections import defaultdict
from pathlib import Path


def load_events(p: Path) -> list[dict]:
    if not p.is_file():
        return []
    text = p.read_text(encoding="utf-8", errors="ignore")
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        # salvage-ish: try array
        return []
    if not isinstance(data, list):
        return []
    return [e for e in data if isinstance(e, dict)]


def summarize(events: list[dict], label: str) -> dict:
    by_agent = defaultdict(lambda: {"n": 0, "tok": 0, "cost": 0.0, "req": 0})
    by_day = defaultdict(lambda: {"n": 0, "tok": 0, "cost": 0.0})
    total_cost = 0.0
    total_tok = 0
    total_req = 0
    router_est = 0
    router_live = 0
    for e in events:
        agent = str(e.get("agent") or "?")
        cost = float(e.get("estimatedCost") or 0)
        tok = int(e.get("totalTokens") or 0)
        if tok <= 0:
            tok = int(e.get("inputTokens") or 0) + int(e.get("outputTokens") or 0)
        req = e.get("requestCount")
        req = int(req) if isinstance(req, (int, float)) and req > 0 else 1
        by_agent[agent]["n"] += 1
        by_agent[agent]["tok"] += tok
        by_agent[agent]["cost"] += cost
        by_agent[agent]["req"] += req
        total_cost += cost
        total_tok += tok
        total_req += req
        day = str(e.get("timestamp") or "")[:10]
        if len(day) == 10:
            by_day[day]["n"] += 1
            by_day[day]["tok"] += tok
            by_day[day]["cost"] += cost
        if agent in ("9router", "routerlab", "xlabrouter"):
            if e.get("estimated"):
                router_est += 1
            else:
                router_live += 1
    print(f"\n=== {label} ===")
    print(f" events={len(events)} cost={total_cost:.2f} tok={total_tok} req={total_req}")
    print(f" router estimated_rows={router_est} live_rows={router_live}")
    print(" by_agent (cost desc):")
    for a, v in sorted(by_agent.items(), key=lambda x: -x[1]["cost"])[:20]:
        print(f"  {a:16} n={v['n']:6} req={v['req']:8} tok={v['tok']:15} cost={v['cost']:12.2f}")
    # top cost days overall
    print(" top cost days:")
    for d, v in sorted(by_day.items(), key=lambda x: -x[1]["cost"])[:8]:
        print(f"  {d} n={v['n']} tok={v['tok']} cost={v['cost']:.2f}")
    return {
        "label": label,
        "events": len(events),
        "cost": total_cost,
        "tok": total_tok,
        "req": total_req,
        "by_agent": {a: dict(v) for a, v in by_agent.items()},
    }


def main() -> int:
    app = Path(os.environ["APPDATA"]) / "tokenlab"
    files = {
        "scan-cache": app / "scan-cache.json",
        "scan-cache.bak": app / "scan-cache.json.bak",
        "archive": app / "scan-cache.archive.json",
        "imported": app / "imported-events.json",
    }
    sums = {}
    for name, p in files.items():
        print(f"file {p} exists={p.is_file()} size={p.stat().st_size if p.is_file() else 0}")
        ev = load_events(p)
        sums[name] = summarize(ev, name)

    # Compare scan-cache vs imported for router agents
    sc = load_events(files["scan-cache"])
    imp = load_events(files["imported"])
    sc_ids = {e.get("id") for e in sc if e.get("id")}
    imp_only = [e for e in imp if e.get("id") not in sc_ids]
    sc_only_router = [
        e
        for e in sc
        if e.get("agent") in ("9router", "routerlab", "xlabrouter")
    ]
    imp_router = [e for e in imp if e.get("agent") in ("9router", "routerlab", "xlabrouter", "xlab-token")]
    print("\n=== imported not in scan-cache ===")
    summarize(imp_only, "imported_only")
    print(" imported_only router-ish", sum(1 for e in imp_only if str(e.get("agent") or "").find("router") >= 0 or e.get("agent") in ("9router", "routerlab", "xlabrouter")))

    # Cost if we union scan+imported by id prefer higher cost
    by_id = {}
    for e in sc + imp:
        i = e.get("id")
        if not i:
            continue
        prev = by_id.get(i)
        if not prev:
            by_id[i] = e
            continue
        pc = float(prev.get("estimatedCost") or 0)
        nc = float(e.get("estimatedCost") or 0)
        pt = int(prev.get("totalTokens") or 0)
        nt = int(e.get("totalTokens") or 0)
        if nt > pt or (nt == pt and nc > pc):
            by_id[i] = e
    summarize(list(by_id.values()), "union_scan+imported_prefer_richer")

    # Agent-level high water: max of scan vs imported per agent cost
    print("\n=== per-agent high-water scan vs imported ===")
    agents = set(sums["scan-cache"]["by_agent"]) | set(sums["imported"]["by_agent"])
    hw = 0.0
    for a in sorted(agents):
        sc_c = sums["scan-cache"]["by_agent"].get(a, {}).get("cost", 0)
        im_c = sums["imported"]["by_agent"].get(a, {}).get("cost", 0)
        m = max(sc_c, im_c)
        hw += m
        if abs(sc_c - im_c) > 1:
            print(f"  {a:16} scan={sc_c:12.2f} import={im_c:12.2f} max={m:12.2f} delta={sc_c-im_c:+.2f}")
    print(f" HIGH_WATER_SUM_AGENTS {hw:.2f}")
    print(f" SCAN_TOTAL {sums['scan-cache']['cost']:.2f}")
    print(f" IMPORT_TOTAL {sums['imported']['cost']:.2f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
