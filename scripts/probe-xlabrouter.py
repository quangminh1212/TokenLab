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
echo '=== services ==='
systemctl is-active xlabrouter 9router 2>/dev/null
echo
systemctl status xlabrouter --no-pager -l 2>/dev/null | head -30
echo
echo '=== unit files ==='
systemctl cat xlabrouter 2>/dev/null | head -50
echo '---'
systemctl cat 9router 2>/dev/null | head -50
echo
echo '=== packages ==='
ls -la /usr/lib/node_modules 2>/dev/null | grep -iE 'xlab|router|9'
ls -la /usr/local/lib/node_modules 2>/dev/null | grep -iE 'xlab|router|9'
npm list -g --depth=0 2>/dev/null
echo
echo '=== bins ==='
which xlabrouter 9router xlab_router 2>/dev/null
ls -la $(which xlabrouter 2>/dev/null) $(which 9router 2>/dev/null) 2>/dev/null
xlabrouter --version 2>&1 | head -5
9router --version 2>&1 | head -5
echo
echo '=== data dirs ==='
ls -la /root/.xlabrouter /root/.9router 2>/dev/null
find /root/.xlabrouter -type f 2>/dev/null
echo
echo '=== ports ==='
ss -ltnp | head -40
echo
echo '=== package main / data path hints ==='
for pkg in xlab_router xlabrouter 9router; do
  for base in /usr/lib/node_modules /usr/local/lib/node_modules; do
    d="$base/$pkg"
    if [ -d "$d" ]; then
      echo "PKG $d"
      cat "$d/package.json" 2>/dev/null | head -40
      rg -n "usageData|usageHistory|\.xlabrouter|\.9router|XDG|APPDATA|homedir|userData" "$d" -g '!node_modules' -g '!*.map' 2>/dev/null | head -40
      find "$d" -maxdepth 3 -type f -name '*.js' 2>/dev/null | head -20
    fi
  done
done
echo
echo '=== db.json usage ==='
python3 - <<'PY'
import json
from pathlib import Path
for p in [Path('/root/.xlabrouter/db.json'), Path('/root/.9router/db.json')]:
    print('FILE', p, p.exists(), p.stat().st_size if p.exists() else 0)
    if not p.exists(): continue
    j=json.loads(p.read_text(encoding='utf-8', errors='ignore'))
    print(' keys', list(j.keys()))
    u=j.get('usageData')
    print(' usageData', type(u).__name__, (list(u.keys()) if isinstance(u,dict) else None))
    if isinstance(u, dict):
        h=u.get('history')
        print(' history', len(h) if isinstance(h,list) else h)
        print(' totalRequestsLifetime', u.get('totalRequestsLifetime'))
    s=j.get('settings') or {}
    print(' port-ish', {k:s.get(k) for k in s if 'port' in k.lower() or 'url' in k.lower() or 'tunnel' in k.lower()})
PY
"""
stdin, stdout, stderr = c.exec_command(cmd, timeout=120)
print(stdout.read().decode("utf-8", "ignore"))
err = stderr.read().decode("utf-8", "ignore")
if err.strip():
    print("STDERR:", err[:2000])
c.close()
