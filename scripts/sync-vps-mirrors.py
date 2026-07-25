#!/usr/bin/env python3
"""
Pull latest 9router + RouterLab (xlabrouter) usage from VPS into local TokenLab mirrors.

Same pattern as 9router daily export:
  - 9router: SQLite usageDaily → usage-daily.json (+ db.json)
  - RouterLab (:1212, DATA_DIR=/var/lib/xlabrouter):
      usageData.dailySummary → usage-daily.json
      usageData.history → usage-history.jsonl
      usageData → usageData.json
      db.json (usage-bearing)

TokenLab agent ids stay `9router` / `xlabrouter` (label: RouterLab).
"""
from __future__ import annotations

import os
import sys

import paramiko

HOST = "36.50.26.247"
USER = "root"
PASSWORD = "a7xe$zZ#NM@2yP8X"

EXPORT_PY = r'''
import json, os, sqlite3, shutil
from pathlib import Path

def export_sqlite_daily(db_path: str, out_path: str) -> int:
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

# --- 9router ---
n9 = export_sqlite_daily("/root/.9router/db/data.sqlite", "/tmp/xlab-mirror-9router-usage-daily.json")
print("EXPORTED_9ROUTER_DAYS", n9)
if os.path.isfile("/root/.9router/db.json"):
    shutil.copyfile("/root/.9router/db.json", "/tmp/xlab-mirror-9router-db.json")
    print("COPIED 9router db.json")

# --- RouterLab / xlabrouter (systemd DATA_DIR) ---
root = Path("/var/lib/xlabrouter")
dbj = root / "db.json"
if not dbj.is_file():
    # legacy path
    dbj = Path("/root/.xlabrouter/db.json")
if dbj.is_file():
    j = json.loads(dbj.read_text(encoding="utf-8", errors="ignore"))
    u = j.get("usageData") or {}
    hist = u.get("history") or []
    daily = u.get("dailySummary") or {}
    if not isinstance(hist, list):
        hist = []
    if not isinstance(daily, dict):
        daily = {}

    Path("/tmp/xlab-mirror-xlabrouter-usage-daily.json").write_text(
        json.dumps(daily, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    print("EXPORTED_ROUTERLAB_DAYS", len(daily), "lifetime", u.get("totalRequestsLifetime"))
    if daily:
        print("ROUTERLAB_RANGE", min(daily), max(daily))

    with open("/tmp/xlab-mirror-xlabrouter-usage-history.jsonl", "w", encoding="utf-8") as f:
        for row in hist:
            if isinstance(row, dict):
                f.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
    print("EXPORTED_ROUTERLAB_HIST", len(hist))

    Path("/tmp/xlab-mirror-xlabrouter-usageData.json").write_text(
        json.dumps(u, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )

    # slim db.json: keep usage + combos + connections meta (no secrets expansion needed for parse)
    slim = {
        "usageData": u,
        "combos": j.get("combos") or [],
        "settings": {
            k: (j.get("settings") or {}).get(k)
            for k in ("comboStrategies", "comboStrategy", "stickyRoundRobinLimit")
            if isinstance(j.get("settings"), dict)
        },
    }
    Path("/tmp/xlab-mirror-xlabrouter-db.json").write_text(
        json.dumps(slim, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    print("COPIED routerlab slim db.json")

    # request-details (recent, compact)
    rd = root / "request-details.json"
    nrd = 0
    if rd.is_file():
        try:
            data = json.loads(rd.read_text(encoding="utf-8", errors="ignore"))
            rec = data.get("records") if isinstance(data, dict) else data
            if not isinstance(rec, list):
                rec = []
            with open("/tmp/xlab-mirror-xlabrouter-request-details.jsonl", "w", encoding="utf-8") as f:
                for row in rec[-3000:]:
                    if not isinstance(row, dict):
                        continue
                    tokens = row.get("tokens") or {}
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
                        "promptTokens": tokens.get("prompt_tokens") if isinstance(tokens, dict) else row.get("promptTokens"),
                        "completionTokens": tokens.get("completion_tokens") if isinstance(tokens, dict) else row.get("completionTokens"),
                    }
                    f.write(json.dumps(slim_row, ensure_ascii=False, separators=(",", ":")) + "\n")
                    nrd += 1
        except Exception as e:
            print("RD_ERR", e)
    print("EXPORTED_ROUTERLAB_RD", nrd)
else:
    print("MISS_ROUTERLAB_DB")
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
        "9router": r"C:\Dev\VPS\my.bnix.one\9router\data",
        "xlabrouter": r"C:\Dev\VPS\my.bnix.one\xlabrouter\data",
    }
    for d in vps_dirs.values():
        parent = os.path.dirname(d)
        if os.path.isdir(parent) or os.path.isdir(d):
            os.makedirs(d, exist_ok=True)

    for mirror_root in mirror_roots:
        os.makedirs(os.path.join(mirror_root, "9router"), exist_ok=True)
        os.makedirs(os.path.join(mirror_root, "xlabrouter"), exist_ok=True)
        # alias folder name for clarity (same content as xlabrouter)
        os.makedirs(os.path.join(mirror_root, "routerlab"), exist_ok=True)

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, password=PASSWORD, timeout=30, allow_agent=False, look_for_keys=False)
    sftp = client.open_sftp()

    with sftp.file("/tmp/xlab_export_mirror.py", "w") as rf:
        rf.write(EXPORT_PY)
    _stdin, stdout, stderr = client.exec_command("python3 /tmp/xlab_export_mirror.py", timeout=180)
    print(stdout.read().decode("utf-8", "ignore"))
    err = stderr.read().decode("utf-8", "ignore")
    if err:
        print("STDERR:", err[:800], file=sys.stderr)

    remote_files = [
        # 9router
        ("/tmp/xlab-mirror-9router-usage-daily.json", "9router", "usage-daily.json"),
        ("/tmp/xlab-mirror-9router-db.json", "9router", "db.json"),
        # RouterLab (agent id xlabrouter)
        ("/tmp/xlab-mirror-xlabrouter-usage-daily.json", "xlabrouter", "usage-daily.json"),
        ("/tmp/xlab-mirror-xlabrouter-usage-history.jsonl", "xlabrouter", "usage-history.jsonl"),
        ("/tmp/xlab-mirror-xlabrouter-usageData.json", "xlabrouter", "usageData.json"),
        ("/tmp/xlab-mirror-xlabrouter-db.json", "xlabrouter", "db.json"),
        ("/tmp/xlab-mirror-xlabrouter-request-details.jsonl", "xlabrouter", "request-details.jsonl"),
    ]

    for remote, agent, name in remote_files:
        # mirror roots
        for mirror_root in mirror_roots:
            local = os.path.join(mirror_root, agent, name)
            try:
                sftp.get(remote, local)
                print("SYNCED", local, "bytes", os.path.getsize(local))
            except Exception as ex:
                print("SKIP", remote, "->", local, ex)
            # dual-write routerlab alias folder for xlabrouter files
            if agent == "xlabrouter":
                alias = os.path.join(mirror_root, "routerlab", name)
                try:
                    sftp.get(remote, alias)
                    print("SYNCED", alias, "bytes", os.path.getsize(alias))
                except Exception as ex:
                    print("SKIP", remote, "->", alias, ex)
        # VPS convenience dirs
        vps = vps_dirs.get(agent)
        if vps and os.path.isdir(vps):
            local = os.path.join(vps, name)
            try:
                sftp.get(remote, local)
                print("SYNCED", local, "bytes", os.path.getsize(local))
            except Exception as ex:
                print("SKIP", remote, "->", local, ex)

    sftp.close()
    client.close()
    print("DONE")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
