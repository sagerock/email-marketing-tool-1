#!/usr/bin/env python3
"""Upload one completed encrypted export with temporary upload-only credentials.

The supervising identity downloads exact object versions separately for recovery
verification. It is never used as the upload client. No scheduling or deletion.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import uuid

import boto3
from boto3.s3.transfer import TransferConfig
from recovery_s3 import assume_writer


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as inp:
        for part in iter(lambda: inp.read(1024 * 1024), b""):
            h.update(part)
    return h.hexdigest()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--backup", type=Path, required=True)
    p.add_argument("--key-status", type=Path, required=True)
    p.add_argument("--account", required=True)
    p.add_argument("--bucket", required=True)
    p.add_argument("--region", default="us-east-2")
    p.add_argument("--apply", action="store_true")
    args = p.parse_args()
    backup = args.backup.resolve()
    if not backup.is_relative_to((Path.home() / ".local/state/sagerock-recovery/backups").resolve()):
        raise ValueError("Private recovery export directory required")
    manifest = json.loads((backup / "manifest.json").read_text())
    status = json.loads(args.key_status.read_text())
    if manifest["status"] != "encrypted-export-complete" or manifest["fingerprint"] != status["fingerprint"]:
        raise ValueError("Completed export with verified recovery key required")
    if status["vault_status"] != "saved-and-downloaded-key-recovery-verified":
        raise ValueError("Vault recovery verification required")
    expected = {"database.dump.gpg", "roles.sql.gpg", "snapshot-evidence.json.gpg", "vault-recovery.json.gpg"}
    artifacts = list(manifest["artifacts"])
    if {a["file"] for a in artifacts} != expected or len(artifacts) != 4:
        raise ValueError("Unexpected archive set; no upload")
    for a in artifacts:
        path = backup / a["file"]
        if path.is_symlink() or path.stat().st_size != a["bytes"] or digest(path) != a["sha256"]:
            raise ValueError("Archive identity/integrity check failed")
    if boto3.client("sts").get_caller_identity()["Account"] != args.account:
        raise ValueError("AWS account mismatch")
    if not args.apply:
        print(json.dumps({"mode": "plan", "bytes": sum(a["bytes"] for a in artifacts), "bucket": args.bucket,
                          "upload_identity": "temporary SageRockRecoveryWriter role", "restore": False}))
        return
    if (backup / "upload-receipt.json").exists():
        raise ValueError("Upload receipt already exists; do not duplicate the backup")
    source = Path(__file__).with_name("backup-database.py")
    spec = importlib.util.spec_from_file_location("backup_database", source)
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    public = args.key_status.parent / "recovery-public-key.asc"
    if digest(public) != status["public_key_sha256"]:
        raise ValueError("Public key changed")
    with tempfile.TemporaryDirectory(prefix="recovery-upload-key-") as td:
        home = Path(td)
        subprocess.run(["gpg", "--homedir", td, "--batch", "--import", str(public)], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            manifest_file = backup / "manifest.json.gpg"
            if manifest_file.exists():
                raise ValueError("Manifest ciphertext already exists; review the interrupted upload before retrying")
            artifacts.append(helper.encrypt(manifest_file, home, status["fingerprint"],
                                           data=(backup / "manifest.json").read_bytes()))
        finally:
            subprocess.run(["gpgconf", "--homedir", td, "--kill", "all"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    writer = assume_writer(args.account, args.region)
    reader = boto3.client("s3", region_name=args.region)
    owner = {"Bucket": args.bucket, "ExpectedBucketOwner": args.account}
    prefix = "production/supabase/" + manifest["project"] + "/" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:12] + "/"
    downloads = backup / "s3-readback"
    downloads.mkdir(mode=0o700)
    receipts = []
    helper.private_json(backup / "upload-intent.json", dict(bucket=args.bucket, prefix=prefix, started_at=datetime.now(timezone.utc).isoformat()))
    for a in artifacts:
        key = prefix + a["file"]
        writer.upload_file(str(backup / a["file"]), args.bucket, key,
            ExtraArgs={"ExpectedBucketOwner": args.account, "ServerSideEncryption": "AES256",
                       "ChecksumAlgorithm": "SHA256", "Metadata": {"ciphertext-sha256": a["sha256"]}},
            Config=TransferConfig(multipart_threshold=16 * 1024 * 1024, multipart_chunksize=16 * 1024 * 1024, max_concurrency=2))
        head = reader.head_object(**owner, Key=key)
        version = head.get("VersionId")
        if not version or version == "null" or head["ContentLength"] != a["bytes"] or head.get("ServerSideEncryption") != "AES256":
            raise ValueError("S3 object version/encryption/size verification failed")
        response = reader.get_object(**owner, Key=key, VersionId=version)
        path = downloads / a["file"]
        try:
            with path.open("xb") as out:
                os.chmod(path, 0o600)
                for block in response["Body"].iter_chunks(1024 * 1024):
                    out.write(block)
        finally:
            response["Body"].close()
        if digest(path) != a["sha256"]:
            raise ValueError("Downloaded ciphertext mismatch")
        receipt = dict(a, key=key, version_id=version, downloaded_sha256_verified=True)
        helper.private_json(backup / (a["file"] + ".s3-receipt.json"), receipt)
        receipts.append(receipt)
        print("Uploaded and verified exact S3 version: " + a["file"], flush=True)
    helper.private_json(backup / "upload-receipt.json", dict(status="uploaded-and-ciphertext-verified", bucket=args.bucket,
        prefix=prefix, artifacts=receipts, finished_at=datetime.now(timezone.utc).isoformat(), restore_verified=False))
    print(json.dumps({"status": "uploaded-and-ciphertext-verified", "artifacts": len(receipts),
                      "encrypted_bytes": sum(a["bytes"] for a in receipts), "restore_verified": False}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        if isinstance(exc, ValueError):
            raise SystemExit(str(exc))
        raise SystemExit("S3 backup failed (" + type(exc).__name__ + "); review private upload intent and receipts before retrying") from None
