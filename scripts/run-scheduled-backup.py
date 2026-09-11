#!/usr/bin/env python3
"""Scheduled encrypted export/upload with verified-outcome Cron Monitor heartbeat.

No private recovery key, restore, automatic retry of exports, or archive deletion.
Configuration and all run artifacts remain outside Git in private Linux storage.
"""
import argparse
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import sys
import time
import urllib.request
import uuid

JOB_ID = "sagerock-supabase-s3-backup"
ROOT = Path.home() / ".local/state/sagerock-recovery"


def atomic_json(path, data):
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(data, indent=2) + "\n")
    temporary.replace(path)


def monitor_settings(path):
    values = {}
    for line in path.read_text().splitlines():
        line = line.strip().removeprefix("export ")
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if separator and key in {"CRON_MONITOR_URL", "CRON_MONITOR_TOKEN"}:
            words = shlex.split(value, comments=True)
            if len(words) != 1:
                raise ValueError("Invalid monitor configuration")
            values[key] = words[0]
    if not values.get("CRON_MONITOR_TOKEN") or not values.get("CRON_MONITOR_URL", "").startswith("https://"):
        raise ValueError("Authenticated HTTPS monitor configuration required")
    return values


def heartbeat(settings, status, message):
    request = urllib.request.Request(settings["CRON_MONITOR_URL"].rstrip("/") + "/heartbeat/" + JOB_ID,
        headers={"Authorization": "Bearer " + settings["CRON_MONITOR_TOKEN"], "Content-Type": "application/json"},
        data=json.dumps({"status": status, "message": message}).encode())
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                if response.status != 202:
                    raise ValueError("Heartbeat was not accepted")
                return
        except Exception:
            if attempt == 2:
                raise RuntimeError("Cron Monitor heartbeat failed") from None
            time.sleep(2)


def run_child(command, log, timeout):
    # Kill the complete process group on timeout, including pg_dump and GnuPG.
    process = subprocess.Popen(command, stdout=log, stderr=log, start_new_session=True)
    try:
        code = process.wait(timeout=timeout)
        if code:
            raise RuntimeError("Backup stage exited unsuccessfully")
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()


def verified_receipt(directory):
    manifest = json.loads((directory / "manifest.json").read_text())
    receipt = json.loads((directory / "upload-receipt.json").read_text())
    expected = {"roles.sql.gpg", "database.dump.gpg", "snapshot-evidence.json.gpg",
                "vault-recovery.json.gpg", "manifest.json.gpg"}
    files = receipt["artifacts"]
    if manifest["status"] != "encrypted-export-complete" or manifest["table_count"] < 1:
        raise ValueError("Completed consistent export required")
    if receipt["status"] != "uploaded-and-ciphertext-verified" or len(files) != 5 or {f["file"] for f in files} != expected:
        raise ValueError("Complete S3 verification receipt required")
    for artifact in files:
        if not artifact.get("downloaded_sha256_verified") or artifact.get("version_id") in (None, "", "null"):
            raise ValueError("Versioned, hash-verified S3 artifacts required")
    # Independently recheck downloaded bytes, including the encrypted manifest.
    import importlib.util
    spec = importlib.util.spec_from_file_location("verify_recovery", Path(__file__).with_name("verify-recovery.py"))
    verifier = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(verifier)
    verifier.verify_readback(directory, receipt)
    return {"tables": manifest["table_count"], "artifacts": len(files), "encrypted_bytes": sum(f["bytes"] for f in files)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    config = json.loads(args.config.read_text())
    settings = monitor_settings(Path(config["monitor_config"]))
    if not args.apply:
        print("Plan: consistent encrypted export, upload-only role, exact-version readback verification, then Cron Monitor heartbeat. No deletion or restore.")
        return 0
    state = ROOT / "scheduled"
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (state / "run.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("A scheduled backup is already running; no duplicate export or heartbeat.")
            return 0
        run_id = "scheduled-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
        output = ROOT / "backups" / run_id
        result = {"run_id": run_id, "started_at": datetime.now(timezone.utc).isoformat(), "status": "running"}
        phase = "preflight"
        try:
            atomic_json(state / "latest-attempt.json", result)
            if shutil.disk_usage(ROOT).free < config["minimum_free_bytes"]:
                raise ValueError("Private backup filesystem is below its free-space reserve")
            scripts = Path(__file__).resolve().parent
            with (state / (run_id + ".log")).open("xb") as log:
                phase = "encrypted export"
                run_child([sys.executable, "-B", str(scripts / "backup-database.py"), "--project", config["project"],
                    "--key-status", config["key_status"], "--ca-file", config["ca_file"], "--output", str(output), "--apply"], log, 2400)
                manifest = json.loads((output / "manifest.json").read_text())
                if sum(a["bytes"] for a in manifest["artifacts"]) > config["maximum_export_bytes"]:
                    raise ValueError("Encrypted export exceeds the configured per-run storage limit")
                phase = "S3 upload and readback"
                run_child([sys.executable, "-B", str(scripts / "upload-recovery.py"), "--backup", str(output),
                    "--key-status", config["key_status"], "--account", config["account"], "--bucket", config["bucket"],
                    "--region", config["region"], "--apply"], log, 900)
            phase = "outcome verification"
            evidence = verified_receipt(output)
            result.update(evidence, status="verified", finished_at=datetime.now(timezone.utc).isoformat(),
                          backup_directory=str(output), restore_performed=False)
            atomic_json(state / (run_id + ".json"), result)
            atomic_json(state / "latest-success.json", result)
            message = f"Encrypted database backup verified: {evidence['tables']} tables; {evidence['artifacts']} exact S3 versions downloaded with matching SHA-256; {evidence['encrypted_bytes']} bytes. No automatic restore."
        except Exception as exc:
            result.update(status="failed", phase=phase, error_type=type(exc).__name__, finished_at=datetime.now(timezone.utc).isoformat())
            atomic_json(state / (run_id + ".json"), result)
            atomic_json(state / "latest-attempt.json", result)
            message = "Database backup failed during " + phase + " (" + type(exc).__name__ + "); inspect private run log."
            try:
                heartbeat(settings, "failed", message)
            except RuntimeError:
                print("Backup failed and heartbeat could not be delivered; overdue monitoring remains the fallback.", file=sys.stderr)
            print(message, file=sys.stderr)
            return 1
        atomic_json(state / "latest-attempt.json", result)
        try:
            heartbeat(settings, "healthy", message)
        except RuntimeError:
            print("Backup verified but Cron Monitor heartbeat failed; inspect the private success receipt.", file=sys.stderr)
            return 1
        print(message)
        return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        raise SystemExit("Scheduled backup setup failed: " + type(exc).__name__) from None
