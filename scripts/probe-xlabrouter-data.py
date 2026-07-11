#!/usr/bin/env python3
from __future__ import annotations

import re
from pathlib import Path

import paramiko

text = Path(r"C:\Dev\VPS\my.bnix.one\info.md").read_text(encoding="utf-8")
host = re.search(r"IP Public:\s*`([^`]+)`", text).group(1)
password = re.search(r"Password:\s*`([^`]+)`", text).group(1)

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(
    hostname=host,
    port=22,
    username="root",
    password=password,
    timeout=30,
    allow_agent=False,
    look_for_keys=False,
)

cmd = r"""
set +e
echo '=== /var/lib/xlabrouter ==='
ls -la /var/lib/xlabrouter 2>/dev/null
find /var/lib/xlabrouter -maxdepth 4 -type f 2>/dev/null | head -100
echo
echo '=== sizes ==='
du -sh /var/lib/xlabrouter/* 2>/dev/null
ls -lah /var/lib/xlabrouter/db.json /var/lib/xlabrouter/usage.json /var/lib/xlabrouter/db/data.sqlite 2>/dev/null
echo
python3 - <<'PY'
import json, sqlite3
from pathlib import Path
root = Path('/var/lib/xlabrouter')
print('root exists', root.exists())
if not root.exists():
    raise SystemExit
for p in sorted(root.rglob('*')):
    if p.is_file() and p.stat().st_size > 0:
        print(f'FILE {p} {p.stat().st_size}')

dbj = root / 'db.json'
if dbj.exists():
    j=json.loads(dbj.read_text(encoding='utf-8', errors='ignore'))
    print('db.json keys', list(j.keys()))
    u=j.get('usageData') or {}
    print('usageData keys', list(u.keys()) if isinstance(u,dict) else type(u))
    if isinstance(u, dict):
        h=u.get('history')
        print('history', len(h) if isinstance(h,list) else h, 'total', u.get('totalRequestsLifetime'))
        if isinstance(h, list) and h:
            print('hist0', json.dumps(h[0])[:500])
            print('histN', json.dumps(h[-1])[:500])

uj = root / 'usage.json'
if uj.exists():
    u=json.loads(uj.read_text(encoding='utf-8', errors='ignore'))
    print('usage.json type', type(u).__name__, list(u.keys())[:20] if isinstance(u,dict) else len(u) if isinstance(u,list) else '')
    if isinstance(u, dict):
        h=u.get('history')
        print('usage history', len(h) if isinstance(h,list) else None, 'total', u.get('totalRequestsLifetime'))
        if isinstance(h,list) and h:
            print('uh0', json.dumps(h[0])[:500])

sql = root / 'db' / 'data.sqlite'
if sql.exists():
    con=sqlite3.connect(f'file:{sql}?mode=ro', uri=True)
    cur=con.cursor()
    tables=[r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'")]
    print('sqlite tables', tables)
    for t in tables:
        try:
            n=cur.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0]
            cols=[c[1] for c in cur.execute(f'PRAGMA table_info({t})')]
            print(f'  {t}: {n} cols={cols}')
            if n and 'usage' in t.lower():
                row=cur.execute(f'SELECT * FROM {t} ORDER BY rowid DESC LIMIT 1').fetchone()
                print('   last', row[:12] if row else None)
        except Exception as e:
            print('  err', t, e)
    con.close()
PY
"""
stdin, stdout, stderr = c.exec_command(cmd, timeout=120)
print(stdout.read().decode("utf-8", "ignore"))
err = stderr.read().decode("utf-8", "ignore")
if err.strip():
    print("STDERR:", err[:2000])
c.close()
