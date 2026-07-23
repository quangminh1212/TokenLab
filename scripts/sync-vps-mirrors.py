#!/usr/bin/env python3
"""Pull latest 9router / xlabrouter usage aggregates from VPS into local mirrors."""
import json
import os
import sys

import paramiko

HOST = "36.50.26.247"
USER = "root"
PASSWORD = "a7xe$zZ#NM@2yP8X"

EXPORT_PY = r"""
import json, os, sqlite3, glob, shutil

def export_daily(db_path, out_path):
    if not os.path.isfile(db_path):
        return 0
    con = sqlite3.connect(db_path)
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
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(daily, f, separators=(',', ':'))
    return len(daily)

n = export_daily('/root/.9router/db/data.sqlite', '/tmp/xlab-mirror-9router-usage-daily.json')
print('EXPORTED_9ROUTER_DAYS', n)
for src, dst_name in [
    ('/var/lib/xlabrouter/db.json', '/tmp/xlab-mirror-xlabrouter-db.json'),
    ('/root/.9router/db.json', '/tmp/xlab-mirror-9router-db.json'),
]:
    if os.path.isfile(src):
        shutil.copyfile(src, '/tmp/' + dst_name.split('/')[-1].replace('xlab-mirror-', 'xlab-mirror-'))
        print('COPIED', src)
"""


def main() -> int:
    appdata = os.environ.get("APPDATA")
    if not appdata:
        print("APPDATA missing", file=sys.stderr)
        return 1
    # Write both TokenLab (primary) and legacy xlab-token mirrors
    mirror_roots = [
        os.path.join(appdata, "tokenlab", "mirrors"),
        os.path.join(appdata, "xlab-token", "mirrors"),
    ]
    # Dev convenience path used by 9router agent roots on this machine
    vps_data = r"C:\Dev\VPS\my.bnix.one\9router\data"
    if os.path.isdir(os.path.dirname(vps_data)) or os.path.isdir(vps_data):
        os.makedirs(vps_data, exist_ok=True)

    for mirror_root in mirror_roots:
        os.makedirs(os.path.join(mirror_root, "9router"), exist_ok=True)
        os.makedirs(os.path.join(mirror_root, "xlabrouter"), exist_ok=True)

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, password=PASSWORD, timeout=25)
    sftp = client.open_sftp()
    with sftp.file("/tmp/xlab_export_mirror.py", "w") as rf:
        rf.write(EXPORT_PY)
    _stdin, stdout, stderr = client.exec_command("python3 /tmp/xlab_export_mirror.py", timeout=180)
    print(stdout.read().decode("utf-8", "ignore"))
    err = stderr.read().decode("utf-8", "ignore")
    if err:
        print("STDERR:", err[:500], file=sys.stderr)

    remote_files = [
        ("/tmp/xlab-mirror-9router-usage-daily.json", "9router", "usage-daily.json"),
        ("/tmp/xlab-mirror-9router-db.json", "9router", "db.json"),
        ("/tmp/xlab-mirror-xlabrouter-db.json", "xlabrouter", "db.json"),
    ]
    for remote, agent, name in remote_files:
        for mirror_root in mirror_roots:
            local = os.path.join(mirror_root, agent, name)
            try:
                sftp.get(remote, local)
                print("SYNCED", local, "bytes", os.path.getsize(local))
            except Exception as ex:
                print("SKIP", remote, "->", local, ex)
        # Also drop 9router daily into VPS local data dir (agent root)
        if agent == "9router" and os.path.isdir(vps_data):
            local = os.path.join(vps_data, name)
            try:
                sftp.get(remote, local)
                print("SYNCED", local, "bytes", os.path.getsize(local))
            except Exception as ex:
                print("SKIP", remote, "->", local, ex)
    sftp.close()
    client.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())