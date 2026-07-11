#!/usr/bin/env python3
"""Pull real xlabrouter DATA_DIR usage from VPS (/var/lib/xlabrouter)."""
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
    Path(r"C:\Dev\VPS\my.bnix.one\xlabrouter\data"),
    Path.home() / "AppData" / "Roaming" / "xlab-token" / "mirrors" / "xlabrouter",
]
for d in dests:
    d.mkdir(parents=True, exist_ok=True)

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
sftp = c.open_sftp()

# remote DATA_DIR from service
remote_root = "/var/lib/xlabrouter"

# Inspect + export usage to jsonl on server side (avoid huge full db if only need usage)
cmd = r"""
python3 - <<'PY'
import json, sys
from pathlib import Path
root = Path('/var/lib/xlabrouter')
dbj = root / 'db.json'
j = json.loads(dbj.read_text(encoding='utf-8', errors='ignore'))
u = j.get('usageData') or {}
hist = u.get('history') or []
daily = u.get('dailySummary') or {}
cockpit = u.get('cockpitImports')
print('history', len(hist), 'totalRequestsLifetime', u.get('totalRequestsLifetime'), file=sys.stderr)
print('daily keys', len(daily) if isinstance(daily, dict) else type(daily), file=sys.stderr)
if isinstance(daily, dict) and daily:
    k = sorted(daily.keys())[-1]
    print('daily sample key', k, json.dumps(daily[k])[:400], file=sys.stderr)
if cockpit is not None:
    print('cockpitImports type', type(cockpit).__name__, file=sys.stderr)
    if isinstance(cockpit, list):
        print('cockpit len', len(cockpit), file=sys.stderr)
    elif isinstance(cockpit, dict):
        print('cockpit keys', list(cockpit.keys())[:20], file=sys.stderr)

# Write history export
out = Path('/tmp/xlabrouter-usage-history.jsonl')
with out.open('w', encoding='utf-8') as f:
    for row in hist:
        f.write(json.dumps(row, ensure_ascii=False, separators=(',', ':')) + '\n')
print('wrote history', len(hist), file=sys.stderr)

# Expand dailySummary into synthetic per-day rollups (for days without event-level history)
# We keep daily as JSON for the parser secondary source
Path('/tmp/xlabrouter-usage-daily.json').write_text(
    json.dumps(daily, ensure_ascii=False), encoding='utf-8'
)
print('wrote daily', len(daily) if isinstance(daily, dict) else 0, file=sys.stderr)

# Also dump full usageData block
Path('/tmp/xlabrouter-usageData.json').write_text(
    json.dumps(u, ensure_ascii=False), encoding='utf-8'
)

# request-details may have richer recent records
rd = root / 'request-details.json'
if rd.exists():
    try:
        data = json.loads(rd.read_text(encoding='utf-8', errors='ignore'))
        records = data.get('records') if isinstance(data, dict) else data
        if not isinstance(records, list):
            records = []
        print('request-details records', len(records), file=sys.stderr)
        with Path('/tmp/xlabrouter-request-details.jsonl').open('w', encoding='utf-8') as f:
            for row in records:
                # only keep usage-ish fields
                if not isinstance(row, dict):
                    continue
                tokens = row.get('tokens') or {}
                slim = {
                    'id': row.get('id'),
                    'timestamp': row.get('timestamp'),
                    'provider': row.get('provider'),
                    'model': row.get('model'),
                    'connectionId': row.get('connectionId'),
                    'endpoint': row.get('endpoint'),
                    'status': row.get('status'),
                    'tokens': tokens,
                    'cost': row.get('cost'),
                    'promptTokens': (tokens or {}).get('prompt_tokens') if isinstance(tokens, dict) else None,
                    'completionTokens': (tokens or {}).get('completion_tokens') if isinstance(tokens, dict) else None,
                }
                f.write(json.dumps(slim, ensure_ascii=False, separators=(',', ':')) + '\n')
    except Exception as e:
        print('request-details parse fail', e, file=sys.stderr)
PY
"""
stdin, stdout, stderr = c.exec_command(cmd, timeout=180)
print(stdout.read().decode("utf-8", "ignore"))
print(stderr.read().decode("utf-8", "ignore"))

# download files
for remote, name in [
    (f"{remote_root}/db.json", "db.json"),
    ("/tmp/xlabrouter-usage-history.jsonl", "usage-history.jsonl"),
    ("/tmp/xlabrouter-usage-daily.json", "usage-daily.json"),
    ("/tmp/xlabrouter-usageData.json", "usageData.json"),
    ("/tmp/xlabrouter-request-details.jsonl", "request-details.jsonl"),
]:
    try:
        tmp = dests[0] / f"_dl_{name}"
        sftp.get(remote, str(tmp))
        for d in dests:
            shutil.copy2(tmp, d / name)
        print("OK", name, tmp.stat().st_size)
        tmp.unlink(missing_ok=True)
    except Exception as e:
        print("SKIP", name, e)

sftp.close()
c.close()
print("DONE")
