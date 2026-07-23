#!/usr/bin/env python3
"""Export 9router usageDaily from VPS SQLite into local mirrors."""
from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

import paramiko

text = Path(r"C:\Dev\VPS\my.bnix.one\info.md").read_text(encoding="utf-8")
host = re.search(r"IP Public:\s*`([^`]+)`", text).group(1)
password = re.search(r"Password:\s*`([^`]+)`", text).group(1)

dests = [
    Path(r"C:\Dev\VPS\my.bnix.one\9router\data"),
    Path.home() / "AppData" / "Roaming" / "tokenlab" / "mirrors" / "9router",
    Path.home() / "AppData" / "Roaming" / "xlab-token" / "mirrors" / "9router",
]
for d in dests:
    d.mkdir(parents=True, exist_ok=True)

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(host, username="root", password=password, timeout=30, allow_agent=False, look_for_keys=False)

cmd = r"""
python3 - <<'PY'
import json, sqlite3
from pathlib import Path
con = sqlite3.connect('file:/root/.9router/db/data.sqlite?mode=ro', uri=True)
daily = {}
for dateKey, data in con.execute('SELECT dateKey, data FROM usageDaily ORDER BY dateKey'):
    try:
        daily[dateKey] = json.loads(data)
    except Exception:
        pass
con.close()
Path('/tmp/9router-usage-daily.json').write_text(json.dumps(daily, ensure_ascii=False), encoding='utf-8')
print('days', len(daily))
if daily:
    print('range', min(daily), max(daily))
    req=sum(int(v.get('requests') or 0) for v in daily.values())
    cost=sum(float(v.get('cost') or 0) for v in daily.values())
    print('req', req, 'cost', cost)
PY
"""
stdin, stdout, stderr = c.exec_command(cmd, timeout=120)
print(stdout.read().decode("utf-8", "ignore"))
print(stderr.read().decode("utf-8", "ignore"))
sftp = c.open_sftp()
tmp = dests[0] / "_usage-daily.json"
sftp.get("/tmp/9router-usage-daily.json", str(tmp))
for d in dests:
    shutil.copy2(tmp, d / "usage-daily.json")
    print("OK", d / "usage-daily.json", (d / "usage-daily.json").stat().st_size)
tmp.unlink(missing_ok=True)
sftp.close()
c.close()
