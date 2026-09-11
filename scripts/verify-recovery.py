#!/usr/bin/env python3
"""Restore S3 readback in a fresh filesystem/network sandbox; retain private proof.

Requires the reviewed local PG17/extension distribution and bubblewrap described
in supabase/RECOVERY.md. No provider writes, uploads, scheduling or cleanup.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile


def verify_readback(backup, receipt):
    expected = {"database.dump.gpg", "roles.sql.gpg", "snapshot-evidence.json.gpg",
                "vault-recovery.json.gpg", "manifest.json.gpg"}
    artifacts = receipt["artifacts"]
    if len(artifacts) != 5 or {a["file"] for a in artifacts} != expected:
        raise ValueError("Exact five-artifact S3 readback required")
    for artifact in artifacts:
        path = backup / "s3-readback" / artifact["file"]
        if path.is_symlink() or path.stat().st_size != artifact["bytes"]:
            raise ValueError("Readback file identity differs")
        digest = hashlib.sha256()
        with path.open("rb") as inp:
            for part in iter(lambda: inp.read(1024 * 1024), b""):
                digest.update(part)
        if digest.hexdigest() != artifact["sha256"]:
            raise ValueError("Readback differs from independently recorded S3 receipt")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backup", type=Path, required=True)
    parser.add_argument("--recovery-kit", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    base = Path.home() / ".local/share/sagerock-recovery"
    backup = args.backup.resolve()
    allowed = Path.home() / ".local/state/sagerock-recovery/backups"
    if not backup.is_relative_to(allowed.resolve()) or backup == allowed.resolve():
        raise ValueError("Private backup directory required")
    receipt = json.loads((backup / "upload-receipt.json").read_text())
    if receipt["status"] != "uploaded-and-ciphertext-verified":
        raise ValueError("Verified S3 readback required")
    verify_readback(backup, receipt)
    if (backup / "restore-verification.json").exists():
        raise ValueError("Restore proof already exists; review before repeating")
    kit = args.recovery_kit.resolve(strict=True)
    if not args.apply:
        print("Plan: restore verified S3 ciphertext in a new private sandbox; no network or provider writes.")
        return
    work = Path(tempfile.mkdtemp(prefix="sagerock-production-restore-"))
    (work / "home").mkdir(mode=0o700)
    (backup / "restore-work-directory.txt").write_text(str(work) + "\n")
    command = [str(base / "bubblewrap/usr/bin/bwrap"), "--unshare-all", "--die-with-parent",
        "--new-session", "--clearenv", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "LANG", "C.UTF-8",
        "--setenv", "HOME", "/work/home", "--setenv", "PYTHONPATH", "/python-packages",
        "--setenv", "RECOVERY_ISOLATED", "1", "--ro-bind", "/usr", "/usr",
        "--symlink", "usr/bin", "/bin", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64",
        "--ro-bind", "/etc/passwd", "/etc/passwd", "--ro-bind", "/etc/group", "/etc/group",
        "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
        "--ro-bind", str(base / "pg17"), "/opt/pg17",
        "--ro-bind", str(Path.home() / ".local/lib/python3.12/site-packages"), "/python-packages",
        "--ro-bind", str(backup / "s3-readback"), "/input", "--ro-bind", str(kit), "/key/kit.json",
        "--ro-bind", str(Path(__file__).with_name("restore-recovery-isolated.py").resolve()), "/app/restore.py",
        "--bind", str(work), "/work", "--chdir", "/work", "/usr/bin/python3", "-B", "/app/restore.py"]
    print("Private isolated restore directory: " + str(work), flush=True)
    subprocess.run(command, check=True)
    result = json.loads((work / "verification.json").read_text())
    result["s3_prefix"] = receipt["prefix"]
    result["s3_bucket"] = receipt["bucket"]
    result["scratch_directory"] = str(work)
    destination = backup / "restore-verification.json"
    with destination.open("x") as out:
        os.chmod(destination, 0o600)
        json.dump(result, out, indent=2)
    print("Verified restore proof saved privately. Scratch contains plaintext restored data; review and remove it after verification.")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        raise SystemExit("Recovery verification failed: " + type(exc).__name__ + "; inspect private scratch diagnostics") from None
