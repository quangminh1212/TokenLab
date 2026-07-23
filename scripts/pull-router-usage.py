#!/usr/bin/env python3
"""Pull 9router + xlabrouter usageHistory from VPS into local XLab Token scan roots."""
from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

import paramiko

INFO = Path(r"C:\Dev\VPS\my.bnix.one\info.md")
text = INFO.read_text(encoding="utf-8")
host = re.search(r"IP Public:\s*`([^`]+)`", text).group(1)
password = re.search(r"Password:\s*`([^`]+)`", text).group(1)

dests_9 = [
    Path(r"C:\Dev\VPS\my.bnix.one\9router\data"),
    Path.home() / "AppData" / "Roaming" / "tokenlab" / "mirrors" / "9router",
    Path.home() / "AppData" / "Roaming" / "xlab-token" / "mirrors" / "9router",
]
dests_x = [
    Path(r"C:\Dev\VPS\my.bnix.one\xlabrouter\data"),
    Path.home() / "AppData" / "Roaming" / "tokenlab" / "mirrors" / "xlabrouter",
    Path.home() / "AppData" / "Roaming" / "xlab-token" / "mirrors" / "xlabrouter",
]
for d in dests_9 + dests_x:
    d.mkdir(parents=True, exist_ok=True)

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(
    hostname=host,
    port=22,
    username="root",
    password=password,
    timeout=30,
    allow_agent=False,
    look_for_keys=False,
)
sftp = client.open_sftp()

for remote, dests in [
    ("/root/.9router/db.json", dests_9),
    ("/root/.xlabrouter/db.json", dests_x),
]:
    try:
        tmp = dests[0] / "_tmp_dl.json"
        sftp.get(remote, str(tmp))
        for d in dests:
            shutil.copy2(tmp, d / "db.json")
        tmp.unlink(missing_ok=True)
        print("OK", remote)
    except Exception as e:
        print("SKIP", remote, e)

cmd = r"""
python3 - <<'PY'
import json, sqlite3, sys
from pathlib import Path

for db, tag in [
    (Path('/root/.9router/db/data.sqlite'), '9router'),
    (Path('/root/.xlabrouter/db/data.sqlite'), 'xlabrouter'),
]:
    if not db.exists():
        print(f'#MISS {tag}', file=sys.stderr)
        continue
    con = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
    con.row_factory = sqlite3.Row
    cur = con.cursor()
    tables = {r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if 'usageHistory' not in tables:
        print(f'#NO_TABLE {tag} {sorted(tables)}', file=sys.stderr)
        con.close()
        continue
    n = 0
    for row in cur.execute(
        '''SELECT id, timestamp, provider, model, connectionId, apiKey, endpoint,
                  promptTokens, completionTokens, cost, status, tokens, meta
           FROM usageHistory ORDER BY id ASC'''
    ):
        d = dict(row)
        d['_agent'] = tag
        print(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
        n += 1
    print(f'#COUNT {tag} {n}', file=sys.stderr)
    # also dump usageDaily for reconciliation
    if 'usageDaily' in tables:
        days = []
        for row in cur.execute('SELECT dateKey, data FROM usageDaily ORDER BY dateKey'):
            days.append({'dateKey': row[0], 'data': row[1]})
        Path(f'/tmp/{tag}-usageDaily.json').write_text(
            json.dumps(days, ensure_ascii=False), encoding='utf-8'
        )
        print(f'#DAILY {tag} {len(days)}', file=sys.stderr)
    con.close()
PY
"""

stdin, stdout, stderr = client.exec_command(cmd, timeout=600)
files = {
    "9router": [d / "usage-history.jsonl" for d in dests_9],
    "xlabrouter": [d / "usage-history.jsonl" for d in dests_x],
}
handles = {k: [open(p, "w", encoding="utf-8") for p in v] for k, v in files.items()}
counts = {"9router": 0, "xlabrouter": 0}
for raw in stdout:
    line = raw.decode("utf-8", "ignore") if isinstance(raw, (bytes, bytearray)) else raw
    line = line.strip()
    if not line:
        continue
    try:
        row = json.loads(line)
    except Exception:
        continue
    agent = row.pop("_agent", "9router")
    out = json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n"
    for h in handles.get(agent, []):
        h.write(out)
    counts[agent] = counts.get(agent, 0) + 1

for hs in handles.values():
    for h in hs:
        h.close()

err = stderr.read().decode("utf-8", "ignore")
print("export:", err.strip())
print("counts:", counts)

# pull daily summaries for verification
for tag, dests in [("9router", dests_9), ("xlabrouter", dests_x)]:
    remote = f"/tmp/{tag}-usageDaily.json"
    try:
        tmp = dests[0] / "usage-daily.json"
        sftp.get(remote, str(tmp))
        for d in dests[1:]:
            shutil.copy2(tmp, d / "usage-daily.json")
        print("OK daily", tag, tmp.stat().st_size)
    except Exception as e:
        print("SKIP daily", tag, e)

sftp.close()
client.close()
print("DONE")
