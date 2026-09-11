#!/usr/bin/env python3
"""Offline scheduler outcome/failure checks; no real credentials or provider calls."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("scheduled", Path(__file__).with_name("run-scheduled-backup.py"))
scheduled = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scheduled)


def synthetic_receipt(directory):
    directory.mkdir(parents=True, exist_ok=True)
    readback = directory / "s3-readback"
    readback.mkdir()
    artifacts = []
    for name in ["roles.sql.gpg", "database.dump.gpg", "snapshot-evidence.json.gpg", "vault-recovery.json.gpg", "manifest.json.gpg"]:
        data = ("synthetic " + name).encode()
        (readback / name).write_bytes(data)
        artifacts.append({"file": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                          "downloaded_sha256_verified": True, "version_id": "synthetic-version"})
    (directory / "manifest.json").write_text(json.dumps({"status": "encrypted-export-complete", "table_count": 2,
                                                         "artifacts": artifacts[:4]}))
    (directory / "upload-receipt.json").write_text(json.dumps({"status": "uploaded-and-ciphertext-verified", "artifacts": artifacts}))


class ScheduledBackupTests(unittest.TestCase):
    def test_complete_receipt_verifies_actual_downloaded_bytes(self):
        with tempfile.TemporaryDirectory() as td:
            directory = Path(td)
            synthetic_receipt(directory)
            self.assertEqual(scheduled.verified_receipt(directory)["tables"], 2)
            (directory / "s3-readback/database.dump.gpg").write_bytes(b"corrupted")
            with self.assertRaises(ValueError):
                scheduled.verified_receipt(directory)

    def test_unversioned_upload_is_not_success(self):
        with tempfile.TemporaryDirectory() as td:
            directory = Path(td)
            synthetic_receipt(directory)
            path = directory / "upload-receipt.json"
            receipt = json.loads(path.read_text())
            receipt["artifacts"][0]["version_id"] = "null"
            path.write_text(json.dumps(receipt))
            with self.assertRaises(ValueError):
                scheduled.verified_receipt(directory)

    def exercise_runner(self, fail):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "scheduled").mkdir()
            old_success = root / "scheduled/latest-success.json"
            old_success.write_text('{"previous":true}')
            config = root / "config.json"
            config.write_text(json.dumps({"monitor_config": "unused", "project": "synthetic",
                "key_status": "unused", "ca_file": "unused", "account": "unused", "bucket": "unused",
                "region": "unused", "minimum_free_bytes": 0, "maximum_export_bytes": 999999}))
            def run(command, log, timeout):
                if fail:
                    raise RuntimeError("synthetic child failed")
                if "--output" in command:
                    synthetic_receipt(Path(command[command.index("--output") + 1]))
            with patch.object(scheduled, "ROOT", root), patch.object(scheduled.sys, "argv", ["run", "--config", str(config), "--apply"]), \
                 patch.object(scheduled, "monitor_settings", return_value={}), patch.object(scheduled, "run_child", side_effect=run), \
                 patch.object(scheduled, "heartbeat") as heartbeat:
                code = scheduled.main()
                status = heartbeat.call_args.args[1]
            if fail:
                self.assertEqual(code, 1)
                self.assertEqual(status, "failed")
                self.assertEqual(json.loads(old_success.read_text()), {"previous": True})
            else:
                self.assertEqual(code, 0)
                self.assertEqual(status, "healthy")
                self.assertFalse(json.loads(old_success.read_text())["restore_performed"])

    def test_failed_export_reports_failure_without_replacing_success(self):
        self.exercise_runner(True)

    def test_success_heartbeat_follows_verified_receipt(self):
        self.exercise_runner(False)

    def test_monitor_config_is_parsed_without_shell_execution(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "monitor.env"
            path.write_text("export CRON_MONITOR_URL='https://example.invalid'\nCRON_MONITOR_TOKEN='$(do-not-execute)'\n")
            values = scheduled.monitor_settings(path)
            self.assertEqual(values["CRON_MONITOR_TOKEN"], "$(do-not-execute)")


if __name__ == "__main__":
    unittest.main()
