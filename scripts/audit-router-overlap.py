#!/usr/bin/env python3
"""Compare 9router usageDaily vs xlabrouter dailySummary + sync imports."""
from __future__ import annotations

import json
import re
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

# 9router daily
con = sqlite3.connect('file:/root/.9router/db/data.sqlite?mode=ro', uri=True)
nine = {}
for dateKey, data in con.execute('SELECT dateKey, data FROM usageDaily'):
    try:
        d = json.loads(data)
    except Exception:
        continue
    nine[dateKey] = {
        'requests': int(d.get('requests') or 0),
        'pt': int(d.get('promptTokens') or 0),
        'ct': int(d.get('completionTokens') or 0),
        'cost': float(d.get('cost') or 0),
    }
con.close()

# xlab daily
j = json.loads(Path('/var/lib/xlabrouter/db.json').read_text(encoding='utf-8', errors='ignore'))
xlab = {}
for dateKey, d in (j.get('usageData') or {}).get('dailySummary', {}).items():
    if not isinstance(d, dict):
        continue
    xlab[dateKey] = {
        'requests': int(d.get('requests') or 0),
        'pt': int(d.get('promptTokens') or 0),
        'ct': int(d.get('completionTokens') or 0),
        'cost': float(d.get('cost') or 0),
    }

# history count per day for 9router
con = sqlite3.connect('file:/root/.9router/db/data.sqlite?mode=ro', uri=True)
hist_by = {}
for (ts,) in con.execute('SELECT timestamp FROM usageHistory'):
    d = (ts or '')[:10]
    hist_by[d] = hist_by.get(d, 0) + 1
con.close()

all_days = sorted(set(nine) | set(xlab))
print('days nine', len(nine), 'xlab', len(xlab), 'union', len(all_days))
print('nine range', min(nine), max(nine))
print('xlab range', min(xlab), max(xlab))

# overlap analysis
same = 0
close = 0
only_nine = 0
only_xlab = 0
for d in all_days:
    a = nine.get(d)
    b = xlab.get(d)
    if a and not b:
        only_nine += 1
    elif b and not a:
        only_xlab += 1
    elif a and b:
        if a['requests'] == b['requests'] and abs(a['cost']-b['cost']) < 0.01:
            same += 1
        elif abs(a['requests']-b['requests'])/max(a['requests'],1) < 0.05:
            close += 1

print(json.dumps({
  'same_day_exact': same,
  'same_day_close': close,
  'only_nine_days': only_nine,
  'only_xlab_days': only_xlab,
}))

# print last 15 days comparison
print('date | nine_req/cost | xlab_req/cost | hist_rows')
for d in all_days[-15:]:
    a = nine.get(d, {})
    b = xlab.get(d, {})
    print(f"{d} | {a.get('requests',0)}/${a.get('cost',0):.2f} | {b.get('requests',0)}/${b.get('cost',0):.2f} | hist={hist_by.get(d,0)}")

# 9router history completeness vs daily
print('--- 9router hist vs daily ---')
gap_days = 0
gap_req = 0
for d, a in sorted(nine.items()):
    h = hist_by.get(d, 0)
    if h < a['requests']:
        gap_days += 1
        gap_req += a['requests'] - h
print(json.dumps({'days_hist_incomplete': gap_days, 'missing_hist_requests_est': gap_req}))
# total hist vs total daily
print(json.dumps({
  'hist_total_rows': sum(hist_by.values()),
  'daily_total_req': sum(v['requests'] for v in nine.values()),
  'daily_total_cost': sum(v['cost'] for v in nine.values()),
  'xlab_daily_req': sum(v['requests'] for v in xlab.values()),
  'xlab_daily_cost': sum(v['cost'] for v in xlab.values()),
}))

# sync state
ss = json.loads(Path('/var/lib/xlabrouter/9router-usage-sync-state.json').read_text(encoding='utf-8', errors='ignore'))
print('sync importedEntryIds', len(ss.get('importedEntryIds') or []))
print('sync batches', len(ss.get('batches') or []))
snaps = ss.get('dailySnapshots') or {}
print('sync dailySnapshots days', len(snaps))
if snaps:
    # sample one
    k = sorted(snaps.keys())[-1]
    v = snaps[k]
    print('snap sample', k, type(v).__name__, (json.dumps(v)[:300] if not isinstance(v, str) else v[:300]))
PY
"""
stdin, stdout, stderr = c.exec_command(cmd, timeout=180)
print(stdout.read().decode("utf-8", "ignore"))
err = stderr.read().decode("utf-8", "ignore")
if err.strip():
    print("STDERR", err[:1500])
c.close()
