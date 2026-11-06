import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "sync-ubuntu-usage.py"
SPEC = importlib.util.spec_from_file_location("sync_ubuntu_usage", SCRIPT)
assert SPEC and SPEC.loader
sync = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = sync
SPEC.loader.exec_module(sync)


class RemoveStaleMirrorFilesTests(unittest.TestCase):
    def test_detects_remote_files_that_were_not_transferred(self):
        same = {"size": 10, "mtime_ns": 1}
        current = {"same.jsonl": same, "new.jsonl": {"size": 20, "mtime_ns": 2}}

        missing = sync._missing_changed_files(
            {"same.jsonl": same}, current, {"new.jsonl"}
        )

        self.assertEqual(missing, set())
        self.assertEqual(
            sync._missing_changed_files(
                {"same.jsonl": same}, current, set()
            ),
            {"new.jsonl"},
        )

    def test_removes_only_files_from_previous_manifest(self):
        with tempfile.TemporaryDirectory() as temp:
            mirror_home = Path(temp) / "home" / "ubuntu"
            old = mirror_home / ".codex" / "sessions" / "old.jsonl"
            current = mirror_home / ".codex" / "sessions" / "current.jsonl"
            untracked = mirror_home / ".codex" / "sessions" / "local.jsonl"
            for file in (old, current, untracked):
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text("{}\n", encoding="utf-8")

            removed, failures = sync._remove_stale_mirror_files(
                mirror_home,
                {".codex/sessions/old.jsonl": {}, ".codex/sessions/current.jsonl": {}},
                {".codex/sessions/current.jsonl": {}},
            )

            self.assertEqual((removed, failures), (1, 0))
            self.assertFalse(old.exists())
            self.assertTrue(current.exists())
            self.assertTrue(untracked.exists())

    def test_rejects_paths_outside_the_mirror(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            mirror_home = root / "home" / "ubuntu"
            mirror_home.mkdir(parents=True)
            outside = root / "outside.jsonl"
            outside.write_text("keep\n", encoding="utf-8")

            removed, failures = sync._remove_stale_mirror_files(
                mirror_home,
                {"../../outside.jsonl": {}},
                {},
            )

            self.assertEqual((removed, failures), (0, 0))
            self.assertTrue(outside.exists())


if __name__ == "__main__":
    unittest.main()
