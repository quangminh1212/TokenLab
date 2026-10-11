#!/usr/bin/env python3
"""
Pull latest RouterLab (xlabrouter) + LiteLLM usage from VPS into local TokenLab mirrors.

Producers:
  - RouterLab (:1212, DATA_DIR=/var/lib/xlabrouter):
      usageData.dailySummary → usage-daily.json
      usageData.history → usage-history.jsonl
      usageData → usageData.json
      db.json (usage-bearing)
  - LiteLLM (:4000, Postgres litellm):
      LiteLLM_DailyUserSpend + SpendLogs → usage-daily.json / usage-history.jsonl
      (TokenLab agent id `litellm`, same router-usage parser shape as RouterLab)

TokenLab agent ids: `xlabrouter` (label: RouterLab) / `litellm`.
9router is retired: the host no longer runs it, so its local mirrors are kept as
a frozen historical database rather than a live feed.

The remote producer runs as a script EXECUTED BY THIS PROCESS over SSH (see
EXPORT_PY).  It is throttled: LiteLLM aggregation is expensive and this is called
about once a minute.  When the throttle trips it must leave the previous run's
files in `/tmp` untouched, because this process then uploads a fixed path list —
a producer that exits without writing anything makes every upload fail.
"""
from __future__ import annotations

import os
import sys

import paramiko

HOST = "36.50.26.247"
USER = "root"
# Use the existing bnix SSH key by default. A password is accepted only when
# supplied explicitly by the environment; credentials must not live in source.
SSH_KEY = os.path.expanduser(
    os.environ.get("TOKENLAB_VPS_SSH_KEY", "~/.ssh/id_ed25519_bnix")
)
PASSWORD = os.environ.get("TOKENLAB_VPS_PASSWORD")

# A local TokenLab timeout can disconnect SSH while the remote command keeps
# running. Serialize the remote export and bound its lifetime so retries do
# not pile up expensive full-table Postgres scans.
REMOTE_EXPORT_LOCK = "/tmp/xlab_export_mirror.lock"
REMOTE_EXPORT_TIMEOUT_SECONDS = 120

EXPORT_PY = r'''
import json, os, sqlite3, shutil, time, glob
from pathlib import Path

# Artifacts from the previous run linger in /tmp, and the downloader copies
# every listed path unconditionally. A producer that finds no source this run
# would therefore republish yesterday's bytes with a fresh mtime, making stale
# data look live. Clear the outputs up front so "absent" means absent.
def _clear(*paths):
    for _p in paths:
        try:
            os.remove(_p)
        except OSError:
            pass

# LiteLLM is the expensive producer and TokenLab calls this every ~60s, so it is
# throttled.  This is a "skip the work", NOT a "produce nothing" signal: the
# caller downloads a fixed list of paths, so a producer that exits without
# writing makes the downloader fail on every one of them and the mirror stops
# updating entirely.
_litellm_marker = Path("/tmp/xlab-mirror-litellm-last-success")
try:
    _litellm_marker_age = time.time() - _litellm_marker.stat().st_mtime
except OSError:
    _litellm_marker_age = float("inf")
_litellm_fresh = _litellm_marker_age < 20

# Cleared unconditionally: the files this run does not rewrite must fall through
# to the "no remote file" path rather than be re-uploaded stale.
_clear(
    "/tmp/xlab-mirror-xlabrouter-usage-daily.json",
    "/tmp/xlab-mirror-xlabrouter-usage-history.jsonl",
    "/tmp/xlab-mirror-xlabrouter-usageData.json",
    "/tmp/xlab-mirror-xlabrouter-db.json",
    "/tmp/xlab-mirror-xlabrouter-request-details.jsonl",
)

# LiteLLM files are the exception -- see below.  A throttled run must NOT clear
# them, because it also does not rewrite them; clear them only in the branch that
# actually produces new ones.

def export_sqlite_daily(db_path: str, out_path: str) -> int:
    """Read a 9router-shaped SQLite `usageDaily` table into a daily JSON map.

    Kept for RouterLab: its history was imported from 9router snapshots and the
    same schema still shows up on the host, so this stays useful even though the
    9router leg itself is retired.
    """
    if not os.path.isfile(db_path):
        return 0
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    cur = con.cursor()
    try:
        rows = cur.execute("SELECT dateKey, data FROM usageDaily ORDER BY dateKey").fetchall()
    except Exception:
        con.close()
        return 0
    daily = {}
    for dk, data in rows:
        try:
            daily[dk] = json.loads(data) if isinstance(data, str) else data
        except Exception:
            pass
    con.close()
    Path(out_path).write_text(json.dumps(daily, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return len(daily)

# --- 9router: retired ---
# TokenLab no longer pulls 9router. The VPS host deleted /root/.9router, so the
# export had been printing MISS_9ROUTER_SQLITE / MISS_9ROUTER_DBJSON and leaving
# 0-byte mirrors behind. Those surviving files are kept as a frozen historical
# database, not a live feed, so there is nothing to sync. The discovery probe and
# the sqlite export were removed with it; re-add them here if 9router returns.



# --- RouterLab / xlabrouter (systemd DATA_DIR) ---
# Live db.json often only keeps a short recent window after wipes/resyncs.
# Merge dailySummary from live + all db.json.bak* + deploy backups so TokenLab
# all-time usage is complete (richer day wins: requests / tokens / cost).
root = Path("/var/lib/xlabrouter")
dbj = root / "db.json"
if not dbj.is_file():
    dbj = Path("/root/.xlabrouter/db.json")

def day_score(d):
    if not isinstance(d, dict):
        return (0, 0, 0.0, 0)
    req = int(d.get("requests") or 0)
    pt = float(d.get("promptTokens") or d.get("prompt_tokens") or 0)
    ct = float(d.get("completionTokens") or d.get("completion_tokens") or 0)
    cost = float(d.get("cost") or 0)
    models = len(d.get("byModel") or {}) if isinstance(d.get("byModel"), dict) else 0
    return (req, int(pt + ct), cost, models)

def load_daily_from_dbjson(p: Path):
    try:
        j = json.loads(p.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        return {}, {}
    u = j.get("usageData") or {}
    daily = u.get("dailySummary") or {}
    if not isinstance(daily, dict):
        daily = {}
    return daily, j

merged_daily = {}
merge_sources = []
candidates = []
if root.is_dir():
    if (root / "db.json").is_file():
        candidates.append(root / "db.json")
    candidates.extend(sorted(root.glob("db.json.bak*")))
    bak_root = root / "backups"
    if bak_root.is_dir():
        candidates.extend(sorted(bak_root.rglob("db.json")))
if dbj.is_file() and dbj not in candidates:
    candidates.insert(0, dbj)

live_j = {}
live_hist = []
for p in candidates:
    daily, full_j = load_daily_from_dbjson(p)
    if p.name == "db.json" and full_j:
        live_j = full_j
        hu = (full_j.get("usageData") or {}).get("history") or []
        if isinstance(hu, list):
            live_hist = hu
    if not daily:
        continue
    n_new = n_up = 0
    for dk, day in daily.items():
        if not isinstance(dk, str) or len(dk) != 10 or not isinstance(day, dict):
            continue
        prev = merged_daily.get(dk)
        if prev is None:
            merged_daily[dk] = day
            n_new += 1
        elif day_score(day) > day_score(prev):
            merged_daily[dk] = day
            n_up += 1
    if n_new or n_up:
        merge_sources.append(f"{p}: +{n_new}/^{n_up}")

# Optional: 9router→RouterLab import snapshots
ss = root / "9router-usage-sync-state.json"
if ss.is_file():
    try:
        st = json.loads(ss.read_text(encoding="utf-8", errors="ignore"))
        snaps = st.get("dailySnapshots") or {}
        if isinstance(snaps, dict):
            n_new = n_up = 0
            for dk, day in snaps.items():
                if isinstance(day, str):
                    try:
                        day = json.loads(day)
                    except Exception:
                        continue
                if not isinstance(day, dict):
                    continue
                if isinstance(day.get("data"), dict) and "requests" not in day:
                    day = day["data"]
                if not isinstance(dk, str) or len(dk) != 10:
                    continue
                if "requests" not in day and "promptTokens" not in day:
                    continue
                prev = merged_daily.get(dk)
                if prev is None:
                    merged_daily[dk] = day
                    n_new += 1
                elif day_score(day) > day_score(prev):
                    merged_daily[dk] = day
                    n_up += 1
            if n_new or n_up:
                merge_sources.append(f"sync-state: +{n_new}/^{n_up}")
    except Exception as e:
        print("SYNC_STATE_ERR", e)

if merged_daily or live_j:
    total_req = sum(int((d or {}).get("requests") or 0) for d in merged_daily.values())
    total_pt = sum(int((d or {}).get("promptTokens") or 0) for d in merged_daily.values())
    total_ct = sum(int((d or {}).get("completionTokens") or 0) for d in merged_daily.values())
    total_cost = sum(float((d or {}).get("cost") or 0) for d in merged_daily.values())

    Path("/tmp/xlab-mirror-xlabrouter-usage-daily.json").write_text(
        json.dumps(merged_daily, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    print(
        "EXPORTED_ROUTERLAB_DAYS",
        len(merged_daily),
        "lifetime_req",
        total_req,
        "pt",
        total_pt,
        "ct",
        total_ct,
        "cost",
        round(total_cost, 4),
    )
    if merged_daily:
        print("ROUTERLAB_RANGE", min(merged_daily), max(merged_daily))
    print("ROUTERLAB_MERGE_SOURCES", len(merge_sources))
    for s in merge_sources[:20]:
        print(" ", s)

    with open("/tmp/xlab-mirror-xlabrouter-usage-history.jsonl", "w", encoding="utf-8") as f:
        for row in live_hist:
            if isinstance(row, dict):
                f.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
    print("EXPORTED_ROUTERLAB_HIST", len(live_hist))

    u_out = {
        "dailySummary": merged_daily,
        "history": live_hist if isinstance(live_hist, list) else [],
        "totalRequestsLifetime": total_req,
        "cockpitImports": ((live_j.get("usageData") or {}).get("cockpitImports") if live_j else None) or [],
    }
    Path("/tmp/xlab-mirror-xlabrouter-usageData.json").write_text(
        json.dumps(u_out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )

    slim = {
        "usageData": u_out,
        "combos": (live_j.get("combos") or []) if live_j else [],
        "settings": {
            k: (live_j.get("settings") or {}).get(k)
            for k in ("comboStrategies", "comboStrategy", "stickyRoundRobinLimit")
            if isinstance(live_j.get("settings"), dict)
        } if live_j else {},
    }
    Path("/tmp/xlab-mirror-xlabrouter-db.json").write_text(
        json.dumps(slim, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    print("COPIED routerlab slim db.json (merged daily)")

    # request-details (full records when small; else last 8000)
    rd = root / "request-details.json"
    nrd = 0
    rd_rows = []
    if rd.is_file():
        try:
            data = json.loads(rd.read_text(encoding="utf-8", errors="ignore"))
            rec = data.get("records") if isinstance(data, dict) else data
            if not isinstance(rec, list):
                rec = []
            # Keep all if modest; otherwise last 8000 for RECENT EVENTS
            take = rec if len(rec) <= 8000 else rec[-8000:]
            with open("/tmp/xlab-mirror-xlabrouter-request-details.jsonl", "w", encoding="utf-8") as f:
                for row in take:
                    if not isinstance(row, dict):
                        continue
                    tokens = row.get("tokens") or {}
                    if not isinstance(tokens, dict):
                        tokens = {}
                    slim_row = {
                        "id": row.get("id"),
                        "timestamp": row.get("timestamp") or row.get("createdAt") or row.get("time"),
                        "provider": row.get("provider"),
                        "model": row.get("model"),
                        "connectionId": row.get("connectionId"),
                        "endpoint": row.get("endpoint") or row.get("route"),
                        "status": row.get("status") or row.get("statusCode"),
                        "tokens": tokens,
                        "cost": row.get("cost"),
                        "promptTokens": tokens.get("prompt_tokens") if tokens else row.get("promptTokens"),
                        "completionTokens": tokens.get("completion_tokens") if tokens else row.get("completionTokens"),
                        "cachedTokens": (
                            tokens.get("cached_tokens")
                            or tokens.get("cache_read_tokens")
                            or tokens.get("cache_read_input_tokens")
                            or row.get("cachedTokens")
                            or 0
                        ),
                    }
                    f.write(json.dumps(slim_row, ensure_ascii=False, separators=(",", ":")) + "\n")
                    rd_rows.append(slim_row)
                    nrd += 1
        except Exception as e:
            print("RD_ERR", e)
    print("EXPORTED_ROUTERLAB_RD", nrd)

    # Rebuild recent daily floors from request-details + history when live daily
    # under-counts requests (common: dailySummary=1 while RD has dozens of calls today).
    def _agg_day_from_rows(rows):
        """Aggregate only rows with real token usage (skip empty stream probes)."""
        from collections import defaultdict
        by_day = defaultdict(lambda: {
            "requests": 0, "promptTokens": 0, "completionTokens": 0,
            "cachedTokens": 0, "cost": 0.0, "byModel": {}
        })
        for row in rows:
            if not isinstance(row, dict):
                continue
            ts = str(row.get("timestamp") or "")
            day = ts[:10]
            if len(day) != 10:
                continue
            tok = row.get("tokens") if isinstance(row.get("tokens"), dict) else {}
            if isinstance(row.get("tokens"), str) and row.get("tokens").strip():
                try:
                    parsed = json.loads(row["tokens"])
                    if isinstance(parsed, dict):
                        tok = parsed
                except Exception:
                    tok = {}
            pt = int(float(tok.get("prompt_tokens") or row.get("promptTokens") or 0))
            ct = int(float(tok.get("completion_tokens") or row.get("completionTokens") or 0))
            cr = int(float(
                tok.get("cached_tokens")
                or tok.get("cache_read_tokens")
                or tok.get("cache_read_input_tokens")
                or row.get("cachedTokens")
                or 0
            ))
            cost = float(row.get("cost") or 0)
            # Empty "say test" / zero-token stream success must NOT inflate request count
            # (VPS dailySummary also ignores them → dashboard shows 1 RQ not 35).
            if pt + ct + cr <= 0 and cost <= 0:
                continue
            model = str(row.get("model") or "mixed")
            provider = str(row.get("provider") or "")
            d = by_day[day]
            d["requests"] += 1
            d["promptTokens"] += pt
            d["completionTokens"] += ct
            d["cachedTokens"] += max(0, cr)
            d["cost"] += cost
            mk = f"{model}|{provider}" if provider else model
            bm = d["byModel"].setdefault(mk, {
                "requests": 0, "promptTokens": 0, "completionTokens": 0,
                "cachedTokens": 0, "cost": 0.0,
                "rawModel": model, "provider": provider or None,
            })
            bm["requests"] += 1
            bm["promptTokens"] += pt
            bm["completionTokens"] += ct
            bm["cachedTokens"] = int(bm.get("cachedTokens") or 0) + max(0, cr)
            bm["cost"] += cost
        return by_day

    rebuilt = _agg_day_from_rows(list(rd_rows) + list(live_hist if isinstance(live_hist, list) else []))
    patched = 0
    for day, built in rebuilt.items():
        prev = merged_daily.get(day) if isinstance(merged_daily.get(day), dict) else {}
        prev_req = int(prev.get("requests") or 0)
        prev_pt = int(prev.get("promptTokens") or 0)
        prev_ct = int(prev.get("completionTokens") or 0)
        prev_cost = float(prev.get("cost") or 0)
        built_req = int(built["requests"])
        built_pt = int(built["promptTokens"])
        built_ct = int(built["completionTokens"])
        built_cost = float(built["cost"])
        # Only lift when RD/hist has *more token volume or cost* than live daily.
        # Never inflate request count alone from zero-token probes.
        if built_pt + built_ct <= prev_pt + prev_ct and built_cost <= prev_cost + 1e-9:
            continue
        new_req = max(prev_req, built_req)
        new_pt = max(prev_pt, built_pt)
        new_ct = max(prev_ct, built_ct)
        new_cost = max(prev_cost, built_cost)
        if new_req == prev_req and new_pt == prev_pt and new_ct == prev_ct and abs(new_cost - prev_cost) < 1e-9:
            continue
        prev_bm = prev.get("byModel") if isinstance(prev.get("byModel"), dict) else {}
        built_bm = built.get("byModel") or {}
        by_model = prev_bm if (prev_pt + prev_ct) >= (built_pt + built_ct) else built_bm
        merged_daily[day] = {
            **prev,
            "requests": new_req,
            "promptTokens": new_pt,
            "completionTokens": new_ct,
            "cost": new_cost,
            "byModel": by_model,
        }
        patched += 1
        print("PATCH_DAY", day, "req", prev_req, "->", new_req, "pt", prev_pt, "->", new_pt)
    if patched:
        # rewrite daily/usageData/db after patch
        total_req = sum(int((d or {}).get("requests") or 0) for d in merged_daily.values())
        total_pt = sum(int((d or {}).get("promptTokens") or 0) for d in merged_daily.values())
        total_ct = sum(int((d or {}).get("completionTokens") or 0) for d in merged_daily.values())
        total_cost = sum(float((d or {}).get("cost") or 0) for d in merged_daily.values())
        Path("/tmp/xlab-mirror-xlabrouter-usage-daily.json").write_text(
            json.dumps(merged_daily, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
        )
        u_out = {
            "dailySummary": merged_daily,
            "history": live_hist if isinstance(live_hist, list) else [],
            "totalRequestsLifetime": total_req,
            "cockpitImports": ((live_j.get("usageData") or {}).get("cockpitImports") if live_j else None) or [],
        }
        Path("/tmp/xlab-mirror-xlabrouter-usageData.json").write_text(
            json.dumps(u_out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
        )
        slim = {
            "usageData": u_out,
            "combos": (live_j.get("combos") or []) if live_j else [],
            "settings": {
                k: (live_j.get("settings") or {}).get(k)
                for k in ("comboStrategies", "comboStrategy", "stickyRoundRobinLimit")
                if isinstance(live_j.get("settings"), dict)
            } if live_j else {},
        }
        Path("/tmp/xlab-mirror-xlabrouter-db.json").write_text(
            json.dumps(slim, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
        )
        print("REWROTE_AFTER_RD_PATCH days", patched, "lifetime_req", total_req, "pt", total_pt, "cost", round(total_cost, 4))
else:
    print("MISS_ROUTERLAB_DB")

# --- LiteLLM (Postgres spend logs → same mirror shape as 9router) ---
# The throttle is applied at the top of this script, before the stale-artifact
# sweep; by the time we get here we are committed to a fresh LiteLLM export.

def _psql(sql: str) -> str:
    import subprocess
    p = subprocess.run(
        ["sudo", "-u", "postgres", "psql", "-d", "litellm", "-t", "-A", "-F", "\t", "-c", sql],
        capture_output=True,
        text=True,
    )
    if p.returncode != 0:
        err = (p.stderr or p.stdout or "").strip()
        print("LITELLM_PSQL_ERR", err[:300])
        return ""
    return (p.stdout or "").rstrip("\n")

def _to_iso_z(ts: str) -> str:
    s = (ts or "").strip()
    if not s:
        return ""
    # "2026-07-29 15:57:01.331" or with +00
    s = s.replace(" ", "T", 1)
    if s.endswith("+00") or s.endswith("+00:00"):
        s = s.split("+")[0] + "Z"
    elif not s.endswith("Z") and "+" not in s[10:] and s.count("-") <= 2:
        s = s + "Z"
    return s

daily_ll = {}


def _litellm_display_model(raw_model: str, model_group: str = "") -> str:
    """Use LiteLLM's public model group, with the current OpenClaw alias fallback."""
    display = (model_group or raw_model or "mixed").strip() or "mixed"
    if display.lower() in ("openclaw", "openai/openclaw"):
        return "glm-5.3"
    return display

# Cache lives in SpendLogs.metadata JSON (not cache_read_input_tokens columns):
#   metadata.usage_object.prompt_tokens_details.cached_tokens
#   metadata.additional_usage_values.prompt_tokens_details.cached_tokens
_SQL_CACHE_READ = (
    "COALESCE("
    "(NULLIF(metadata #>> '{usage_object,prompt_tokens_details,cached_tokens}', ''))::bigint, "
    "(NULLIF(metadata #>> '{additional_usage_values,prompt_tokens_details,cached_tokens}', ''))::bigint, "
    "(NULLIF(metadata #>> '{usage,prompt_tokens_details,cached_tokens}', ''))::bigint, "
    "0)"
)
_SQL_CACHE_WRITE = (
    "COALESCE("
    "(NULLIF(metadata #>> '{usage_object,prompt_tokens_details,cache_write_tokens}', ''))::bigint, "
    "(NULLIF(metadata #>> '{usage_object,prompt_tokens_details,cache_creation_input_tokens}', ''))::bigint, "
    "(NULLIF(metadata #>> '{additional_usage_values,prompt_tokens_details,cache_write_tokens}', ''))::bigint, "
    "0)"
)


def _cache_from_metadata_text(meta_text: str) -> tuple[int, int]:
    """Best-effort cache read/write from LiteLLM SpendLogs metadata JSON."""
    if not meta_text or meta_text in ("", "{}", "null"):
        return 0, 0
    try:
        meta = json.loads(meta_text)
    except Exception:
        return 0, 0
    if not isinstance(meta, dict):
        return 0, 0

    def _n(src, *keys):
        if not isinstance(src, dict):
            return 0
        for k in keys:
            if k in src and src[k] is not None:
                try:
                    return int(float(src[k]))
                except Exception:
                    pass
        return 0

    def _details(usage_obj):
        if not isinstance(usage_obj, dict):
            return {}
        d = (
            usage_obj.get("prompt_tokens_details")
            or usage_obj.get("promptTokensDetails")
            or usage_obj.get("input_tokens_details")
            or {}
        )
        return d if isinstance(d, dict) else {}

    # Walk known nesting (usage_object is the real SoT on this VPS)
    bags = []
    for key in ("usage_object", "usage", "additional_usage_values", "token_usage"):
        u = meta.get(key)
        if isinstance(u, dict):
            bags.append(u)
            bags.append(_details(u))
    bags.append(_details(meta))
    bags.append(meta)

    cr = cw = 0
    for bag in bags:
        if not cr:
            cr = _n(
                bag,
                "cached_tokens",
                "cache_read_tokens",
                "cache_read_input_tokens",
                "cachedTokens",
                "cacheReadTokens",
            )
        if not cw:
            cw = _n(
                bag,
                "cache_write_tokens",
                "cache_creation_input_tokens",
                "cacheWriteTokens",
                "cache_creation_tokens",
            )
        if cr and cw:
            break
    return max(0, cr), max(0, cw)


# SpendLogs day totals — cache from metadata JSON path (authoritative per-request cache)
raw_logs_day = _psql(
    'SELECT ("startTime"::date)::text, COUNT(*), '
    "COALESCE(SUM(prompt_tokens),0), COALESCE(SUM(completion_tokens),0), "
    f"COALESCE(SUM(spend),0), COALESCE(SUM({_SQL_CACHE_READ}),0) "
    'FROM "LiteLLM_SpendLogs" '
    'WHERE COALESCE(prompt_tokens,0)+COALESCE(completion_tokens,0)>0 OR COALESCE(spend,0)>0 '
    "GROUP BY 1 ORDER BY 1"
)
if not raw_logs_day:
    # Fallback without JSON cache extraction
    raw_logs_day = _psql(
        'SELECT ("startTime"::date)::text, COUNT(*), '
        "COALESCE(SUM(prompt_tokens),0), COALESCE(SUM(completion_tokens),0), "
        "COALESCE(SUM(spend),0), 0::bigint "
        'FROM "LiteLLM_SpendLogs" '
        'WHERE COALESCE(prompt_tokens,0)+COALESCE(completion_tokens,0)>0 OR COALESCE(spend,0)>0 '
        "GROUP BY 1 ORDER BY 1"
    )
if raw_logs_day:
    for line in raw_logs_day.splitlines():
        parts = line.split("\t")
        if len(parts) < 5:
            continue
        date_key = (parts[0] or "").strip()[:10]
        if len(date_key) != 10:
            continue
        try:
            reqs = int(float(parts[1] or 0))
            pt = int(float(parts[2] or 0))
            ct = int(float(parts[3] or 0))
            cost = float(parts[4] or 0)
            cache_r = int(float(parts[5] or 0)) if len(parts) > 5 else 0
        except Exception:
            continue
        daily_ll[date_key] = {
            "requests": reqs, "promptTokens": pt, "completionTokens": ct,
            "cachedTokens": max(0, cache_r), "cost": cost, "byModel": {},
        }

raw_by_model = _psql(
    'SELECT ("startTime"::date)::text, '
    "COALESCE(NULLIF(model_group,''), COALESCE(model,'mixed')), "
    "COALESCE(model,'mixed'), COALESCE(custom_llm_provider,''), COUNT(*), "
    "COALESCE(SUM(prompt_tokens),0), COALESCE(SUM(completion_tokens),0), "
    f"COALESCE(SUM(spend),0), COALESCE(SUM({_SQL_CACHE_READ}),0) "
    'FROM "LiteLLM_SpendLogs" '
    'WHERE COALESCE(prompt_tokens,0)+COALESCE(completion_tokens,0)>0 OR COALESCE(spend,0)>0 '
    "GROUP BY 1,2,3,4 ORDER BY 1"
)
if not raw_by_model:
    raw_by_model = _psql(
        'SELECT ("startTime"::date)::text, '
        "COALESCE(NULLIF(model_group,''), COALESCE(model,'mixed')), "
        "COALESCE(model,'mixed'), COALESCE(custom_llm_provider,''), COUNT(*), "
        "COALESCE(SUM(prompt_tokens),0), COALESCE(SUM(completion_tokens),0), "
        "COALESCE(SUM(spend),0), 0::bigint "
        'FROM "LiteLLM_SpendLogs" '
        'WHERE COALESCE(prompt_tokens,0)+COALESCE(completion_tokens,0)>0 OR COALESCE(spend,0)>0 '
        "GROUP BY 1,2,3,4 ORDER BY 1"
    )
if raw_by_model:
    for line in raw_by_model.splitlines():
        parts = line.split("\t")
        if len(parts) < 8:
            continue
        date_key = (parts[0] or "").strip()[:10]
        if len(date_key) != 10:
            continue
        model_group = (parts[1] or "").strip()
        raw_model = (parts[2] or "mixed").strip() or "mixed"
        model = _litellm_display_model(raw_model, model_group)
        provider = (parts[3] or "").strip()
        try:
            reqs = int(float(parts[4] or 0))
            pt = int(float(parts[5] or 0))
            ct = int(float(parts[6] or 0))
            cost = float(parts[7] or 0)
            cache_r = int(float(parts[8] or 0)) if len(parts) > 8 else 0
        except Exception:
            continue
        day = daily_ll.setdefault(date_key, {
            "requests": 0, "promptTokens": 0, "completionTokens": 0,
            "cachedTokens": 0, "cost": 0.0, "byModel": {},
        })
        bm = day.setdefault("byModel", {})
        if not isinstance(bm, dict):
            bm = {}
            day["byModel"] = bm
        mk = f"{model}|{provider}" if provider else model
        bm[mk] = {
            "requests": reqs, "promptTokens": pt, "completionTokens": ct,
            "cachedTokens": max(0, cache_r), "cost": cost, "model_group": model,
            "rawModel": raw_model,
            "provider": provider or None,
        }

# Overlay DailyUserSpend cache only when SpendLogs metadata path under-counts
raw_daily = _psql(
    'SELECT date, COALESCE(model, \'\'), COALESCE(custom_llm_provider, \'\'), '
    "COALESCE(SUM(prompt_tokens),0), COALESCE(SUM(completion_tokens),0), "
    "COALESCE(SUM(cache_read_input_tokens),0), COALESCE(SUM(cache_creation_input_tokens),0), "
    "COALESCE(SUM(spend),0), COALESCE(SUM(api_requests),0), "
    "COALESCE(SUM(successful_requests),0) "
    'FROM "LiteLLM_DailyUserSpend" '
    "GROUP BY date, model, custom_llm_provider ORDER BY date"
)
if raw_daily:
    for line in raw_daily.splitlines():
        parts = line.split("\t")
        if len(parts) < 10:
            continue
        date_key = (parts[0] or "").strip()[:10]
        if len(date_key) != 10:
            continue
        raw_model = (parts[1] or "").strip() or "mixed"
        model = _litellm_display_model(raw_model)
        provider = (parts[2] or "").strip()
        try:
            pt = int(float(parts[3] or 0))
            ct = int(float(parts[4] or 0))
            cache_r = int(float(parts[5] or 0))
            cost = float(parts[7] or 0)
            reqs = int(float(parts[8] or 0))
            ok = int(float(parts[9] or 0))
        except Exception:
            continue
        if reqs <= 0 and ok > 0:
            reqs = ok
        if pt + ct + cache_r <= 0 and cost <= 0 and reqs <= 0:
            continue
        day = daily_ll.setdefault(date_key, {
            "requests": 0, "promptTokens": 0, "completionTokens": 0,
            "cachedTokens": 0, "cost": 0.0, "byModel": {},
        })
        mk = f"{model}|{provider}" if provider else model
        bm = day.setdefault("byModel", {})
        if not isinstance(bm, dict):
            bm = {}
            day["byModel"] = bm
        row = bm.setdefault(mk, {
            "requests": 0, "promptTokens": 0, "completionTokens": 0,
            "cachedTokens": 0, "cost": 0.0, "model_group": model,
            "rawModel": raw_model,
            "provider": provider or None,
        })
        row["requests"] = int(row.get("requests") or 0) + max(0, reqs)
        row["promptTokens"] = int(row.get("promptTokens") or 0) + max(0, pt)
        row["completionTokens"] = int(row.get("completionTokens") or 0) + max(0, ct)
        row["cost"] = float(row.get("cost") or 0) + max(0.0, cost)
        prev_c = int(row.get("cachedTokens") or 0)
        # Prefer SpendLogs metadata sum; only raise if DailyUserSpend reports more
        row["cachedTokens"] = max(prev_c, max(0, cache_r))

# Day-level totals MUST equal the sum of their byModel rows, otherwise the day
# row and its own breakdown disagree and TokenLab's period filters ("today")
# read a bogus frozen value. This runs at module scope rather than inside the
# `if raw_daily:` block above: DailyUserSpend is a batched rollup that can be
# empty or mid-rotation, and the SpendLogs-only paths can diverge without it.
for _dk, day in daily_ll.items():
    if not isinstance(day, dict):
        continue
    bm = day.get("byModel") or {}
    if not isinstance(bm, dict) or not bm:
        continue
    req_sum = pt_sum = ct_sum = cache_sum = 0
    cost_sum = 0.0
    for _m in bm.values():
        if not isinstance(_m, dict):
            continue
        req_sum += int(_m.get("requests") or 0)
        pt_sum += int(_m.get("promptTokens") or 0)
        ct_sum += int(_m.get("completionTokens") or 0)
        cache_sum += int(_m.get("cachedTokens") or 0)
        cost_sum += float(_m.get("cost") or 0)
    day["requests"] = max(int(day.get("requests") or 0), req_sum)
    day["promptTokens"] = max(int(day.get("promptTokens") or 0), pt_sum)
    day["completionTokens"] = max(int(day.get("completionTokens") or 0), ct_sum)
    day["cachedTokens"] = max(int(day.get("cachedTokens") or 0), cache_sum)
    day["cost"] = max(float(day.get("cost") or 0), cost_sum)

# History: always pull SQL-extracted cache + metadata text (for nested fallback parse)
hist_rows = []
raw_hist = _psql(
    'SELECT request_id, "startTime"::text, COALESCE(model,\'\'), '
    "COALESCE(custom_llm_provider,''), COALESCE(prompt_tokens,0), "
    "COALESCE(completion_tokens,0), COALESCE(spend,0), COALESCE(status,''), "
    "COALESCE(call_type,''), COALESCE(model_group,''), "
    f"{_SQL_CACHE_READ}, {_SQL_CACHE_WRITE}, "
    "COALESCE(metadata::text,'') "
    'FROM "LiteLLM_SpendLogs" '
    'ORDER BY "startTime" DESC LIMIT 8000'
)
if not raw_hist:
    # metadata only (no JSON path support)
    raw_hist = _psql(
        'SELECT request_id, "startTime"::text, COALESCE(model,\'\'), '
        "COALESCE(custom_llm_provider,''), COALESCE(prompt_tokens,0), "
        "COALESCE(completion_tokens,0), COALESCE(spend,0), COALESCE(status,''), "
        "COALESCE(call_type,''), COALESCE(model_group,''), "
        "0, 0, COALESCE(metadata::text, '') "
        'FROM "LiteLLM_SpendLogs" '
        'ORDER BY "startTime" DESC LIMIT 8000'
    )
if not raw_hist:
    raw_hist = _psql(
        'SELECT request_id, "startTime"::text, COALESCE(model,\'\'), '
        "COALESCE(custom_llm_provider,''), COALESCE(prompt_tokens,0), "
        "COALESCE(completion_tokens,0), COALESCE(spend,0), COALESCE(status,''), "
        "COALESCE(call_type,''), COALESCE(model_group,''), "
        "0, 0, '' "
        'FROM "LiteLLM_SpendLogs" '
        'ORDER BY "startTime" DESC LIMIT 8000'
    )
if raw_hist:
    for line in reversed(raw_hist.splitlines()):
        parts = line.split("\t")
        if len(parts) < 7:
            continue
        rid = (parts[0] or "").strip()
        ts = _to_iso_z(parts[1] or "")
        raw_model = (parts[2] or "").strip() or "mixed"
        model_group = (parts[9] or "").strip() if len(parts) > 9 else ""
        model = _litellm_display_model(raw_model, model_group)
        provider = (parts[3] or "").strip()
        try:
            pt = int(float(parts[4] or 0))
            ct = int(float(parts[5] or 0))
            cost = float(parts[6] or 0)
        except Exception:
            continue
        status = (parts[7] if len(parts) > 7 else "") or ""
        try:
            cache_r = int(float(parts[10] or 0)) if len(parts) > 10 else 0
            cache_w = int(float(parts[11] or 0)) if len(parts) > 11 else 0
        except Exception:
            cache_r, cache_w = 0, 0
        meta_text = parts[12] if len(parts) > 12 else ""
        # psql -A may leave tabs inside JSON; rejoin remainder as metadata
        if len(parts) > 13:
            meta_text = "\t".join(parts[12:])
        m_cr, m_cw = _cache_from_metadata_text(meta_text)
        cache_r = max(cache_r, m_cr)
        cache_w = max(cache_w, m_cw)
        if pt + ct + cache_r + cache_w <= 0 and cost <= 0:
            continue
        if not ts:
            continue
        tok = {"prompt_tokens": pt, "completion_tokens": ct}
        if cache_r > 0:
            tok["cached_tokens"] = cache_r
        if cache_w > 0:
            tok["cache_creation_input_tokens"] = cache_w
            tok["cache_write_tokens"] = cache_w
        hist_rows.append({
            "id": rid or f"ll-{ts}-{model}-{pt}-{ct}",
            "timestamp": ts,
            "model": model,
            "model_group": model,
            "rawModel": raw_model,
            "provider": provider or None,
            "promptTokens": pt,
            "completionTokens": ct,
            "cachedTokens": cache_r,
            "cost": cost,
            "status": status,
            "tokens": tok,
        })

if _litellm_fresh:
    print("SKIP_LITELLM_SPEND fresh_marker age=%.0fs (leaving previous mirror)" % _litellm_marker_age)
elif daily_ll or hist_rows:
    # Only now, with fresh data in hand, is it safe to drop the previous run's
    # files.  Clearing earlier would destroy a good mirror whenever this branch is
    # not reached (throttled, locked out, timed out, or psql failed).
    _clear(
        "/tmp/xlab-mirror-litellm-usage-daily.json",
        "/tmp/xlab-mirror-litellm-usage-history.jsonl",
        "/tmp/xlab-mirror-litellm-db.json",
    )
    Path("/tmp/xlab-mirror-litellm-usage-daily.json").write_text(
        json.dumps(daily_ll, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    total_req = sum(int((d or {}).get("requests") or 0) for d in daily_ll.values())
    total_pt = sum(int((d or {}).get("promptTokens") or 0) for d in daily_ll.values())
    total_ct = sum(int((d or {}).get("completionTokens") or 0) for d in daily_ll.values())
    total_cost = sum(float((d or {}).get("cost") or 0) for d in daily_ll.values())
    print(
        "EXPORTED_LITELLM_DAYS", len(daily_ll),
        "lifetime_req", total_req, "pt", total_pt, "ct", total_ct,
        "cost", round(total_cost, 6),
    )
    if daily_ll:
        print("LITELLM_RANGE", min(daily_ll), max(daily_ll))
    with open("/tmp/xlab-mirror-litellm-usage-history.jsonl", "w", encoding="utf-8") as f:
        for row in hist_rows:
            f.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
    print("EXPORTED_LITELLM_HIST", len(hist_rows))
    slim = {
        "usageData": {
            "dailySummary": daily_ll,
            "history": hist_rows[-500:] if len(hist_rows) > 500 else hist_rows,
            "totalRequestsLifetime": total_req,
        }
    }
    Path("/tmp/xlab-mirror-litellm-db.json").write_text(
        json.dumps(slim, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    print("COPIED litellm slim db.json")
elif not _litellm_fresh:
    print("MISS_LITELLM_SPEND")
if not _litellm_fresh:
    _litellm_marker.write_text(str(time.time()), encoding="utf-8")
'''


def main() -> int:
    appdata = os.environ.get("APPDATA")
    if not appdata:
        print("APPDATA missing", file=sys.stderr)
        return 1

    mirror_roots = [
        os.path.join(appdata, "tokenlab", "mirrors"),
        os.path.join(appdata, "xlab-token", "mirrors"),
    ]
    vps_dirs = {
        "xlabrouter": r"C:\Dev\VPS\my.bnix.one\xlabrouter\data",
        "litellm": r"C:\Dev\VPS\my.bnix.one\litellm\data",
    }
    for d in vps_dirs.values():
        parent = os.path.dirname(d)
        if os.path.isdir(parent) or os.path.isdir(d):
            os.makedirs(d, exist_ok=True)

    for mirror_root in mirror_roots:
        os.makedirs(os.path.join(mirror_root, "xlabrouter"), exist_ok=True)
        # alias folder name for clarity (same content as xlabrouter)
        os.makedirs(os.path.join(mirror_root, "routerlab"), exist_ok=True)
        os.makedirs(os.path.join(mirror_root, "litellm"), exist_ok=True)

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    connect_kwargs = {
        "hostname": HOST,
        "username": USER,
        "timeout": 30,
        "allow_agent": True,
        "look_for_keys": True,
    }
    if PASSWORD:
        connect_kwargs["password"] = PASSWORD
    elif os.path.isfile(SSH_KEY):
        connect_kwargs["key_filename"] = SSH_KEY
    else:
        raise RuntimeError(
            "No VPS credential configured; set TOKENLAB_VPS_SSH_KEY or "
            "TOKENLAB_VPS_PASSWORD"
        )
    client.connect(**connect_kwargs)
    sftp = client.open_sftp()

    with sftp.file("/tmp/xlab_export_mirror.py", "w") as rf:
        rf.write(EXPORT_PY)
    remote_cmd = (
        f"if ! flock -n {REMOTE_EXPORT_LOCK} "
        f"timeout --signal=TERM --kill-after=10s {REMOTE_EXPORT_TIMEOUT_SECONDS}s "
        "python3 /tmp/xlab_export_mirror.py; then "
        "rc=$?; "
        'if [ "$rc" = "1" ]; then echo "SKIP_LOCKED another export holds '
        f'{REMOTE_EXPORT_LOCK}"; fi; '
        'if [ "$rc" = "124" ] || [ "$rc" = "137" ]; then echo "TIMEOUT_EXPORT '
        f'after {REMOTE_EXPORT_TIMEOUT_SECONDS}s"; fi; '
        'echo "EXPORT_EXIT $rc"; '
        "fi"
    )
    _stdin, stdout, stderr = client.exec_command(remote_cmd, timeout=180)
    out = stdout.read().decode("utf-8", "ignore")
    print(out if out.strip() else "EXPORT_NO_OUTPUT (remote printed nothing)")
    err = stderr.read().decode("utf-8", "ignore")
    if err:
        print("STDERR:", err[:800], file=sys.stderr)

    remote_files = [
        # RouterLab (agent id xlabrouter)
        ("/tmp/xlab-mirror-xlabrouter-usage-daily.json", "xlabrouter", "usage-daily.json"),
        ("/tmp/xlab-mirror-xlabrouter-usage-history.jsonl", "xlabrouter", "usage-history.jsonl"),
        ("/tmp/xlab-mirror-xlabrouter-usageData.json", "xlabrouter", "usageData.json"),
        ("/tmp/xlab-mirror-xlabrouter-db.json", "xlabrouter", "db.json"),
        ("/tmp/xlab-mirror-xlabrouter-request-details.jsonl", "xlabrouter", "request-details.jsonl"),
        # LiteLLM (agent id litellm)
        ("/tmp/xlab-mirror-litellm-usage-daily.json", "litellm", "usage-daily.json"),
        ("/tmp/xlab-mirror-litellm-usage-history.jsonl", "litellm", "usage-history.jsonl"),
        ("/tmp/xlab-mirror-litellm-db.json", "litellm", "db.json"),
    ]

    def pull(remote: str, local: str) -> bool:
        """Copy remote -> local, but never leave a truncated or empty artifact.

        sftp.get() writes to the destination as it streams, so a missing or
        half-written remote file used to leave a 0-byte local file behind.  The
        mirror then looked present while holding no data.  Verify the source
        exists and is non-empty first, and stage through a temp file so a failed
        transfer cannot clobber a good mirror.

        A size change between stat() and get() means another writer was mid-write
        (the RouterLab service rewrites these files on its own schedule).  Look at
        the size once more before giving up, so that case does not silently cost
        the mirror a refresh cycle.
        """
        for attempt in (1, 2):
            try:
                st = sftp.stat(remote)
            except Exception as ex:
                if attempt == 1:
                    time.sleep(2)
                    continue
                print("SKIP", remote, "->", local, "(no remote file)", ex)
                return False
            if st.st_size <= 0:
                print("SKIP", remote, "->", local, "(remote is 0 bytes)")
                return False

            tmp = local + ".part"
            try:
                sftp.get(remote, tmp)
            except Exception as ex:
                print("SKIP", remote, "->", local, ex)
                try:
                    os.remove(tmp)
                except OSError:
                    pass
                return False

            size = os.path.getsize(tmp)
            if size == st.st_size:
                os.replace(tmp, local)
                print("SYNCED", local, "bytes", size)
                return True

            # Rewritten underneath us; drop the partial and retry once.
            try:
                os.remove(tmp)
            except OSError:
                pass
            if attempt == 2:
                print("SKIP", remote, "->", local, "size mismatch", size, "!=", st.st_size)
                return False
            time.sleep(2)

        return False

    for remote, agent, name in remote_files:
        # mirror roots
        for mirror_root in mirror_roots:
            local = os.path.join(mirror_root, agent, name)
            pull(remote, local)
            # dual-write routerlab alias folder for xlabrouter files
            if agent == "xlabrouter":
                pull(remote, os.path.join(mirror_root, "routerlab", name))
        # VPS convenience dirs
        vps = vps_dirs.get(agent)
        if vps and os.path.isdir(vps):
            pull(remote, os.path.join(vps, name))

    sftp.close()
    client.close()
    print("DONE")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
