#!/usr/bin/env python3
"""Export merged RouterLab dailySummary (live + all backups) for TokenLab mirrors.

Live /var/lib/xlabrouter/db.json only keeps recent days after a wipe; older usage
still sits in db.json.bak* and deploy backups. Merge by dateKey keeping the
richer day (higher requests / tokens / cost).
"""
from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

import paramiko

HOST = "36.50.26.247"
PASSWORD = os.environ.get("VPS_SSH_PASSWORD") or "a7xe$zZ#NM@2yP8X"

EXPORT_PY = r'''
import json
from pathlib import Path

root = Path("/var/lib/xlabrouter")

def day_score(d: dict) -> tuple:
    if not isinstance(d, dict):
        return (0, 0, 0.0)
    req = int(d.get("requests") or 0)
    pt = float(d.get("promptTokens") or d.get("prompt_tokens") or 0)
    ct = float(d.get("completionTokens") or d.get("completion_tokens") or 0)
    cost = float(d.get("cost") or 0)
    models = len(d.get("byModel") or {}) if isinstance(d.get("byModel"), dict) else 0
    return (req, int(pt + ct), cost, models)

def load_daily_from_dbjson(p: Path) -> dict:
    try:
        j = json.loads(p.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        return {}
    u = j.get("usageData") or {}
    daily = u.get("dailySummary") or {}
    return daily if isinstance(daily, dict) else {}

merged = {}
sources = []

candidates = []
if (root / "db.json").is_file():
    candidates.append(root / "db.json")
for p in sorted(root.glob("db.json.bak*")):
    candidates.append(p)
bak_root = root / "backups"
if bak_root.is_dir():
    candidates.extend(sorted(bak_root.rglob("db.json")))

for p in candidates:
    daily = load_daily_from_dbjson(p)
    if not daily:
        continue
    n_new = 0
    n_up = 0
    for dk, day in daily.items():
        if not isinstance(dk, str) or len(dk) != 10:
            continue
        if not isinstance(day, dict):
            continue
        prev = merged.get(dk)
        if prev is None:
            merged[dk] = day
            n_new += 1
        elif day_score(day) > day_score(prev):
            merged[dk] = day
            n_up += 1
    if n_new or n_up:
        sources.append({"path": str(p), "days_in_file": len(daily), "merged_new": n_new, "merged_up": n_up})

# Also fold 9router-usage-sync-state dailySnapshots if present
ss = root / "9router-usage-sync-state.json"
if ss.is_file():
    try:
        st = json.loads(ss.read_text(encoding="utf-8", errors="ignore"))
        snaps = st.get("dailySnapshots") or st.get("daily") or {}
        if isinstance(snaps, dict):
            n_new = n_up = 0
            for dk, day in snaps.items():
                if not isinstance(day, dict):
                    # snapshot might wrap payload
                    if isinstance(day, str):
                        try:
                            day = json.loads(day)
                        except Exception:
                            continue
                    else:
                        continue
                # unwrap nested data
                if "promptTokens" not in day and isinstance(day.get("data"), dict):
                    day = day["data"]
                if "promptTokens" not in day and "requests" not in day:
                    continue
                prev = merged.get(dk)
                if prev is None:
                    merged[dk] = day
                    n_new += 1
                elif day_score(day) > day_score(prev):
                    merged[dk] = day
                    n_up += 1
            sources.append({"path": str(ss), "merged_new": n_new, "merged_up": n_up})
    except Exception as e:
        sources.append({"path": str(ss), "error": str(e)})

# totals
req = pt = ct = cost = 0.0
for d in merged.values():
    req += int(d.get("requests") or 0)
    pt += float(d.get("promptTokens") or 0)
    ct += float(d.get("completionTokens") or 0)
    cost += float(d.get("cost") or 0)

out = {
    "dailySummary": merged,
    "totalRequestsLifetime": int(req),
    "history": [],  # filled separately from live history
    "mergedFrom": sources,
    "meta": {
        "days": len(merged),
        "requests": int(req),
        "promptTokens": int(pt),
        "completionTokens": int(ct),
        "cost": round(cost, 6),
        "range": [min(merged), max(merged)] if merged else None,
    },
}

# attach live history ring
try:
    live = json.loads((root / "db.json").read_text(encoding="utf-8", errors="ignore"))
    hist = (live.get("usageData") or {}).get("history") or []
    if isinstance(hist, list):
        out["history"] = hist
except Exception:
    pass

Path("/tmp/xlab-mirror-routerlab-usage-daily-full.json").write_text(
    json.dumps(merged, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
)
Path("/tmp/xlab-mirror-routerlab-usageData-full.json").write_text(
    json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
)
# slim db for parser
slim = {"usageData": {"dailySummary": merged, "history": out["history"], "totalRequestsLifetime": int(req)}}
Path("/tmp/xlab-mirror-routerlab-db-full.json").write_text(
    json.dumps(slim, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
)
print("MERGED_DAYS", len(merged))
print("MERGED_REQ", int(req))
print("MERGED_PT", int(pt))
print("MERGED_CT", int(ct))
print("MERGED_COST", round(cost, 4))
print("MERGED_RANGE", min(merged) if merged else None, max(merged) if merged else None)
print("SOURCES", len(sources))
for s in sources[-12:]:
    print(" SRC", s)
'''


def write_local(path: Path, data: bytes | str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(data, bytes):
        path.write_bytes(data)
    else:
        path.write_text(data, encoding="utf-8")
    print("WROTE", path, path.stat().st_size)


def main() -> int:
    appdata = os.environ.get("APPDATA")
    if not appdata:
        print("APPDATA missing", file=sys.stderr)
        return 1

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username="root", password=PASSWORD, timeout=30, allow_agent=False, look_for_keys=False)
    sftp = client.open_sftp()
    with sftp.file("/tmp/export_routerlab_full_daily.py", "w") as rf:
        rf.write(EXPORT_PY)
    _i, o, e = client.exec_command("python3 /tmp/export_routerlab_full_daily.py", timeout=180)
    print(o.read().decode("utf-8", "replace"))
    err = e.read().decode("utf-8", "replace")
    if err.strip():
        print("STDERR", err[:800], file=sys.stderr)

    remote_map = {
        "/tmp/xlab-mirror-routerlab-usage-daily-full.json": "usage-daily.json",
        "/tmp/xlab-mirror-routerlab-usageData-full.json": "usageData.json",
        "/tmp/xlab-mirror-routerlab-db-full.json": "db.json",
    }

    dests = []
    for mirror_root in [
        Path(appdata) / "tokenlab" / "mirrors",
        Path(appdata) / "xlab-token" / "mirrors",
    ]:
        for agent in ("routerlab", "xlabrouter"):
            dests.append(mirror_root / agent)
    vps = Path(r"C:\Dev\VPS\my.bnix.one\xlabrouter\data")
    if vps.parent.exists() or vps.exists():
        dests.append(vps)
    vps2 = Path(r"C:\Dev\VPS\my.bnix.one\routerlab\data")
    dests.append(vps2)

    for remote, name in remote_map.items():
        tmp = Path(os.environ.get("TEMP", ".")) / f"_rl_{name}"
        try:
            sftp.get(remote, str(tmp))
        except Exception as ex:
            print("SKIP get", remote, ex)
            continue
        raw = tmp.read_bytes()
        for d in dests:
            write_local(d / name, raw)
        tmp.unlink(missing_ok=True)

    # also refresh history/request-details from live (unchanged paths in main sync)
    for remote, name in [
        ("/tmp/xlab-mirror-xlabrouter-usage-history.jsonl", "usage-history.jsonl"),
        ("/tmp/xlab-mirror-xlabrouter-request-details.jsonl", "request-details.jsonl"),
    ]:
        # may not exist unless main sync ran — ignore
        try:
            tmp = Path(os.environ.get("TEMP", ".")) / f"_rl_{name}"
            sftp.get(remote, str(tmp))
            raw = tmp.read_bytes()
            for d in dests:
                write_local(d / name, raw)
            tmp.unlink(missing_ok=True)
        except Exception:
            pass

    sftp.close()
    client.close()

    # verify local
    p = Path(appdata) / "tokenlab" / "mirrors" / "routerlab" / "usage-daily.json"
    daily = json.loads(p.read_text(encoding="utf-8"))
    req = sum(int((v or {}).get("requests") or 0) for v in daily.values() if isinstance(v, dict))
    pt = sum(int((v or {}).get("promptTokens") or 0) for v in daily.values() if isinstance(v, dict))
    print("LOCAL_VERIFY days", len(daily), "req", req, "pt", pt, "range", min(daily), max(daily))
    print("DONE")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
