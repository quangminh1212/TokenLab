#!/usr/bin/env python3
"""Audit VPS raw usage vs local mirrors for 9router + xlabrouter."""
from __future__ import annotations

import json
import re
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import paramiko

text = Path(r"C:\Dev\VPS\my.bnix.one\info.md").read_text(encoding="utf-8")
host = re.search(r"IP Public:\s*`([^`]+)`", text).group(1)
password = re.search(r"Password:\s*`([^`]+)`", text).group(1)

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(host, username="root", password=password, timeout=30, allow_agent=False, look_for_keys=False)

cmd = r"""
python3 - <<'PY'
import json, sqlite3
from pathlib import Path
from collections import defaultdict

def day_stats_from_history(rows):
    by = defaultdict(lambda: {'n':0,'pt':0,'ct':0,'cost':0.0})
    for r in rows:
        ts = r.get('timestamp') or ''
        d = ts[:10]
        if len(d) < 10: continue
        tok = r.get('tokens') or {}
        if isinstance(tok, str):
            try: tok = json.loads(tok)
            except Exception: tok = {}
        pt = int(r.get('promptTokens') or (tok or {}).get('prompt_tokens') or 0)
        ct = int(r.get('completionTokens') or (tok or {}).get('completion_tokens') or 0)
        cost = float(r.get('cost') or 0)
        by[d]['n'] += 1
        by[d]['pt'] += pt
        by[d]['ct'] += ct
        by[d]['cost'] += cost
    return by

print('=== 9ROUTER SQLITE ===')
db = Path('/root/.9router/db/data.sqlite')
con = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
con.row_factory = sqlite3.Row
cur = con.cursor()
n = cur.execute('SELECT COUNT(*) FROM usageHistory').fetchone()[0]
pt = cur.execute('SELECT COALESCE(SUM(promptTokens),0), COALESCE(SUM(completionTokens),0), COALESCE(SUM(cost),0) FROM usageHistory').fetchone()
print(json.dumps({'rows': n, 'promptTokens': pt[0], 'completionTokens': pt[1], 'cost': pt[2]}))
# min/max ts
mm = cur.execute('SELECT MIN(timestamp), MAX(timestamp) FROM usageHistory').fetchone()
print(json.dumps({'min': mm[0], 'max': mm[1]}))
# daily table
daily_n = cur.execute('SELECT COUNT(*) FROM usageDaily').fetchone()[0]
print(json.dumps({'usageDaily_rows': daily_n}))
# sum daily table tokens/cost
dpt=dct=dcost=dreq=0
for row in cur.execute('SELECT dateKey, data FROM usageDaily'):
    try:
        d=json.loads(row[1])
    except Exception:
        continue
    dreq += int(d.get('requests') or 0)
    dpt += int(d.get('promptTokens') or 0)
    dct += int(d.get('completionTokens') or 0)
    dcost += float(d.get('cost') or 0)
print(json.dumps({'usageDaily_sum': {'requests': dreq, 'promptTokens': dpt, 'completionTokens': dct, 'cost': dcost}}))
con.close()

print('=== XLABROUTER DATA_DIR ===')
root = Path('/var/lib/xlabrouter')
j = json.loads((root/'db.json').read_text(encoding='utf-8', errors='ignore'))
u = j.get('usageData') or {}
hist = u.get('history') or []
daily = u.get('dailySummary') or {}
print(json.dumps({
  'history_len': len(hist),
  'totalRequestsLifetime': u.get('totalRequestsLifetime'),
  'dailySummary_days': len(daily) if isinstance(daily, dict) else None,
}))
# history totals
hpt=hct=hcost=0
for r in hist:
    tok=r.get('tokens') or {}
    hpt += int((tok or {}).get('prompt_tokens') or r.get('promptTokens') or 0)
    hct += int((tok or {}).get('completion_tokens') or r.get('completionTokens') or 0)
    hcost += float(r.get('cost') or 0)
print(json.dumps({'history_sum': {'n': len(hist), 'pt': hpt, 'ct': hct, 'cost': hcost}}))
# daily totals
dpt=dct=dcost=dreq=0
for k,v in (daily or {}).items():
    if not isinstance(v, dict): continue
    dreq += int(v.get('requests') or 0)
    dpt += int(v.get('promptTokens') or 0)
    dct += int(v.get('completionTokens') or 0)
    dcost += float(v.get('cost') or 0)
print(json.dumps({'daily_sum': {'requests': dreq, 'pt': dpt, 'ct': dct, 'cost': dcost, 'days': len(daily)}}))
# request-details
rd = root/'request-details.json'
if rd.exists():
    data=json.loads(rd.read_text(encoding='utf-8', errors='ignore'))
    rec=data.get('records') if isinstance(data, dict) else data
    print(json.dumps({'request_details_records': len(rec) if isinstance(rec, list) else type(rec).__name__}))
# check for sqlite under xlab
sqls=list(root.rglob('*.sqlite'))+list(root.rglob('*.db'))
print(json.dumps({'sqlite_files': [str(p) for p in sqls]}))
# 9router-usage-sync-state
ss = root/'9router-usage-sync-state.json'
if ss.exists():
    s=json.loads(ss.read_text(encoding='utf-8', errors='ignore'))
    print(json.dumps({'sync_state_keys': list(s.keys())[:30] if isinstance(s, dict) else type(s).__name__, 'size': ss.stat().st_size}))
    if isinstance(s, dict):
        for k in list(s.keys())[:15]:
            v=s[k]
            if isinstance(v, (int,float,str,bool)) or v is None:
                print('  ', k, v)
            elif isinstance(v, list):
                print('  ', k, 'list', len(v))
            elif isinstance(v, dict):
                print('  ', k, 'dict keys', list(v.keys())[:10])
PY
"""
stdin, stdout, stderr = c.exec_command(cmd, timeout=180)
print(stdout.read().decode("utf-8", "ignore"))
err = stderr.read().decode("utf-8", "ignore")
if err.strip():
    print("STDERR", err[:2000])
c.close()
