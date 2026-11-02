"""Mirror supported usage records from the SSH host named `ubuntu`.

The remote side only reads files under the remote home. SSH uses the user's
normal OpenSSH config and agent/key setup; no credentials are stored here.
"""

from __future__ import annotations

import io
import json
import os
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path, PurePosixPath


REMOTE_EXPORT_SCRIPT = r'''
import io, json, os, stat, sys, tarfile

payload = json.load(sys.stdin)
roots_by_agent = payload.get("roots", {})
previous = payload.get("previous", {})
home = os.path.realpath(os.path.expanduser("~"))
excluded_dirs = {
    ".git", ".cache", "cache", "node_modules", "tools", "installs",
    "plugins", "skills", "venv", ".venv", "__pycache__", "tests",
    "test", "website", "apps", "hermes-agent",
}
database_names = {
    "state.db", "hermes.db", "sessions.db", "opencode.db",
    "state.vscdb", "usage.db", "history.db",
}
usage_words = ("usage", "history", "session", "transcript", "event", "activity", "stats", "summary")

def within_home(candidate):
    try:
        return os.path.commonpath([home, candidate]) == home
    except (ValueError, OSError):
        return False

def is_usage_file(name):
    lower = name.lower()
    if lower.endswith((".jsonl", ".jsonl.zst", ".jsonl.zstd", ".ndjson")):
        return True
    if lower.endswith((".db", ".sqlite", ".sqlite3", ".vscdb")):
        return lower in database_names or lower.startswith("opencode") or lower.endswith(".vscdb")
    if lower.endswith("-wal"):
        base = lower[:-4]
        return base in database_names or base.startswith("opencode") or base.endswith(".vscdb")
    if lower.endswith(".json"):
        stem = lower[:-5]
        return any(word in stem for word in usage_words)
    return False

files = {}
manifest = {}
active_roots = {}
for agent, roots in roots_by_agent.items():
    for root in roots:
        expanded_root = os.path.expanduser(root)
        if os.path.islink(expanded_root):
            continue
        candidate_root = os.path.realpath(expanded_root)
        if not within_home(candidate_root) or candidate_root == home or not os.path.isdir(candidate_root):
            continue
        root_has_usage = False
        for current, dirs, names in os.walk(candidate_root, topdown=True, followlinks=False):
            dirs[:] = [d for d in dirs if d.lower() not in excluded_dirs]
            for name in names:
                full = os.path.join(current, name)
                try:
                    info = os.lstat(full)
                except OSError:
                    continue
                if not stat.S_ISREG(info.st_mode) or not is_usage_file(name):
                    continue
                real = os.path.realpath(full)
                if not within_home(real):
                    continue
                relative = os.path.relpath(real, home).replace(os.sep, "/")
                record = {"size": info.st_size, "mtime_ns": info.st_mtime_ns}
                manifest[relative] = record
                files[relative] = real
                root_has_usage = True
        if root_has_usage:
            active_roots.setdefault(agent, []).append(candidate_root)

changed = [name for name, record in manifest.items() if previous.get(name) != record]
out = sys.stdout.buffer
with tarfile.open(fileobj=out, mode="w|") as archive:
    for relative in changed:
        full = files[relative]
        try:
            info = os.stat(full, follow_symlinks=False)
            if not stat.S_ISREG(info.st_mode):
                continue
            item = tarfile.TarInfo(relative)
            item.size = info.st_size
            item.mtime = info.st_mtime
            with open(full, "rb") as source:
                archive.addfile(item, source)
        except OSError:
            continue
    raw_roots = json.dumps(active_roots, separators=(",", ":")).encode("utf-8")
    item = tarfile.TarInfo("__tokenlab_roots__.json")
    item.size = len(raw_roots)
    archive.addfile(item, io.BytesIO(raw_roots))
    raw_manifest = json.dumps(manifest, separators=(",", ":")).encode("utf-8")
    item = tarfile.TarInfo("__tokenlab_manifest__.json")
    item.size = len(raw_manifest)
    archive.addfile(item, io.BytesIO(raw_manifest))
'''


def _creation_flags() -> int:
    return getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _report(message: str) -> None:
    try:
        if sys.stdout is not None:
            sys.stdout.write(message + "\n")
            sys.stdout.flush()
    except OSError:
        pass


def _safe_target(base: Path, archive_name: str) -> Path | None:
    relative = PurePosixPath(archive_name)
    if relative.is_absolute() or any(part in ("", ".", "..") for part in relative.parts):
        return None
    target = (base / Path(*relative.parts)).resolve()
    try:
        target.relative_to(base.resolve())
    except ValueError:
        return None
    return target


def _load_json(path: Path, fallback):
    try:
        with path.open("r", encoding="utf-8") as stream:
            return json.load(stream)
    except (OSError, ValueError, TypeError):
        return fallback


def main() -> int:
    if len(sys.argv) != 2:
        print("SYNC_FAILED missing root manifest", file=sys.stderr)
        return 2

    root_manifest_path = Path(sys.argv[1])
    roots = _load_json(root_manifest_path, {})
    if not isinstance(roots, dict) or not roots:
        print("SYNC_FAILED no Linux source roots", file=sys.stderr)
        return 2

    appdata = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
    mirror_base = Path(appdata) / "tokenlab" / "mirrors" / "ubuntu"
    mirror_home = mirror_base / "home" / "ubuntu"
    local_manifest_path = mirror_base / "sync-manifest.json"
    previous = _load_json(local_manifest_path, {})
    if not isinstance(previous, dict):
        previous = {}
    previous = {
        name: record
        for name, record in previous.items()
        if isinstance(name, str) and _safe_target(mirror_home, name) is not None
        and _safe_target(mirror_home, name).is_file()
    }
    active_roots = None

    payload = json.dumps({"roots": roots, "previous": previous}, separators=(",", ":")).encode("utf-8")
    remote_command = "python3 -c " + shlex.quote(REMOTE_EXPORT_SCRIPT)
    command = [
        "ssh",
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=15",
        "-T",
        "ubuntu",
        remote_command,
    ]

    try:
        with tempfile.TemporaryFile() as tar_stream:
            result = subprocess.run(
                command,
                input=payload,
                stdout=tar_stream,
                stderr=subprocess.PIPE,
                timeout=270,
                check=False,
                creationflags=_creation_flags(),
            )
            if result.returncode != 0:
                detail = (result.stderr or b"").decode("utf-8", "replace").strip()
                _report("SYNC_FAILED ssh exit=%d %s" % (result.returncode, detail[:240]))
                return 1

            tar_stream.seek(0)
            mirror_home.mkdir(parents=True, exist_ok=True)
            updated = 0
            transferred_bytes = 0
            remote_manifest = None
            with tarfile.open(fileobj=tar_stream, mode="r:") as archive:
                for member in archive:
                    if not member.isfile():
                        continue
                    if member.name == "__tokenlab_manifest__.json":
                        content = archive.extractfile(member)
                        if content is not None:
                            remote_manifest = json.loads(content.read().decode("utf-8"))
                        continue
                    if member.name == "__tokenlab_roots__.json":
                        content = archive.extractfile(member)
                        if content is not None:
                            active_roots = json.loads(content.read().decode("utf-8"))
                        continue
                    target = _safe_target(mirror_home, member.name)
                    content = archive.extractfile(member)
                    if target is None or content is None:
                        continue
                    target.parent.mkdir(parents=True, exist_ok=True)
                    temporary = target.with_name(target.name + ".tokenlab-tmp")
                    with temporary.open("wb") as destination:
                        shutil.copyfileobj(content, destination, length=1024 * 1024)
                    os.replace(temporary, target)
                    updated += 1
                    transferred_bytes += member.size

            if not isinstance(remote_manifest, dict):
                _report("SYNC_FAILED missing remote manifest")
                return 1
            if not isinstance(active_roots, dict):
                _report("SYNC_FAILED missing active root list")
                return 1
            mirror_base.mkdir(parents=True, exist_ok=True)
            temporary_manifest = local_manifest_path.with_name(local_manifest_path.name + ".tmp")
            temporary_manifest.write_text(json.dumps(remote_manifest, separators=(",", ":")), encoding="utf-8")
            os.replace(temporary_manifest, local_manifest_path)
            active_roots_path = mirror_base / "remote-roots-active.json"
            temporary_roots = active_roots_path.with_name(active_roots_path.name + ".tmp")
            temporary_roots.write_text(json.dumps(active_roots, separators=(",", ":")), encoding="utf-8")
            os.replace(temporary_roots, active_roots_path)
            _report(
                "SYNC_OK files=%d updated=%d bytes=%d" %
                (len(remote_manifest), updated, transferred_bytes)
            )
            return 0
    except subprocess.TimeoutExpired:
        _report("SYNC_FAILED ssh timeout")
        return 1
    except Exception as error:
        _report("SYNC_FAILED %s" % str(error)[:240])
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
