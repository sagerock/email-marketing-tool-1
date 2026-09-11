#!/usr/bin/env python3
"""Offline failure-injection checks; disposable key and synthetic data only."""
import hashlib
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("backup_database", Path(__file__).with_name("backup-database.py"))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)
verify_spec = importlib.util.spec_from_file_location("verify_recovery", Path(__file__).with_name("verify-recovery.py"))
verify = importlib.util.module_from_spec(verify_spec)
verify_spec.loader.exec_module(verify)


class EncryptionPipelineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="synthetic-backup-pipeline-")
        self.root = Path(self.temp.name)
        self.home = self.root / "keyring"
        self.home.mkdir(mode=0o700)
        subprocess.run(["gpg", "--homedir", str(self.home), "--batch", "--pinentry-mode", "loopback",
            "--passphrase", "", "--quick-generate-key", "Disposable Backup Test <test@example.invalid>",
            "rsa2048", "encr", "1d"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        result = subprocess.run(["gpg", "--homedir", str(self.home), "--with-colons", "--list-keys"],
            check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.fingerprint = next(line.split(":")[9] for line in result.stdout.decode().splitlines() if line.startswith("fpr:"))

    def tearDown(self):
        subprocess.run(["gpgconf", "--homedir", str(self.home), "--kill", "all"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.temp.cleanup()

    def test_success_recovers_exact_input(self):
        destination = self.root / "synthetic.gpg"
        evidence = backup.encrypt(destination, self.home, self.fingerprint, data=b"synthetic backup\n")
        result = subprocess.run(["gpg", "--homedir", str(self.home), "--batch", "--decrypt", str(destination)],
            check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.assertEqual(result.stdout, b"synthetic backup\n")
        self.assertEqual(evidence["sha256"], hashlib.sha256(destination.read_bytes()).hexdigest())
        self.assertFalse(destination.with_name(destination.name + ".partial").exists())

    def test_producer_failure_never_publishes_completed_archive(self):
        destination = self.root / "failed.gpg"
        with self.assertRaises(RuntimeError):
            backup.encrypt(destination, self.home, self.fingerprint,
                command=[sys.executable, "-c", "import sys; sys.stdout.write('incomplete synthetic data'); sys.exit(7)"])
        self.assertFalse(destination.exists())
        self.assertTrue(destination.with_name(destination.name + ".partial").exists())

    def test_encryption_failure_never_publishes_completed_archive(self):
        destination = self.root / "missing-recipient.gpg"
        with self.assertRaises(RuntimeError):
            backup.encrypt(destination, self.home, "0" * 40, data=b"synthetic backup\n")
        self.assertFalse(destination.exists())


class ReadbackTests(unittest.TestCase):
    def test_changed_ciphertext_fails_before_restore(self):
        with tempfile.TemporaryDirectory(prefix="synthetic-readback-") as td:
            root = Path(td)
            (root / "s3-readback").mkdir()
            artifacts = []
            for name in ["database.dump.gpg", "roles.sql.gpg", "snapshot-evidence.json.gpg", "vault-recovery.json.gpg", "manifest.json.gpg"]:
                content = ("synthetic " + name).encode()
                (root / "s3-readback" / name).write_bytes(content)
                artifacts.append({"file": name, "bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()})
            receipt = {"artifacts": artifacts}
            verify.verify_readback(root, receipt)
            path = root / "s3-readback/manifest.json.gpg"
            path.write_bytes(b"x" * path.stat().st_size)
            with self.assertRaises(ValueError):
                verify.verify_readback(root, receipt)


if __name__ == "__main__":
    unittest.main()
