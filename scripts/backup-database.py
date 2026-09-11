#!/usr/bin/env python3
"""Supervised logical backup: verified TLS, one database snapshot, encrypted output.

No S3 upload or scheduling. Uses a short-lived Supabase administrative login;
database reads and pg_dump run in read-only transactions. No password reset.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from datetime import datetime, timezone
import urllib.request

import psycopg2
from psycopg2 import sql

BIN = Path("/usr/lib/postgresql/17/bin")


def management(project, route, body=None):
    token = (Path.home() / ".supabase/access-token").read_text().strip()
    request = urllib.request.Request(f"https://api.supabase.com/v1/projects/{project}/{route}",
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except Exception:
        raise RuntimeError("Management request failed: " + route) from None


def private_json(path, value):
    with path.open("x") as out:
        os.chmod(path, 0o600)
        json.dump(value, out, indent=2, default=str)
        out.write("\n")


def encrypt(path, home, fingerprint, data=None, command=None, env=None):
    """Plaintext flows only through memory/pipes; failed outputs stay .partial."""
    partial = path.with_name(path.name + ".partial")
    producer = None
    with partial.open("xb") as output, path.with_name(path.name + ".stderr").open("xb") as errors:
        os.chmod(partial, 0o600)
        os.chmod(errors.name, 0o600)
        if command:
            producer = subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=errors)
        gpg = subprocess.Popen(["gpg", "--homedir", str(home), "--batch", "--no-tty",
            "--trust-model", "always", "--encrypt", "--recipient", fingerprint],
            stdin=producer.stdout if producer else subprocess.PIPE, stdout=output, stderr=errors)
        if producer:
            producer.stdout.close()
        try:
            if producer:
                code = producer.wait(timeout=1800)
                gpg_code = gpg.wait(timeout=120)
            else:
                gpg.communicate(data, timeout=60)
                code, gpg_code = 0, gpg.returncode
            if code or gpg_code:
                raise RuntimeError("Encrypted export failed: " + path.name + "; see private diagnostic file")
        finally:
            for child in [producer, gpg]:
                if child and child.poll() is None:
                    child.terminate()
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait()
    partial.rename(path)
    h = hashlib.sha256()
    with path.open("rb") as inp:
        for block in iter(lambda: inp.read(1024 * 1024), b""):
            h.update(block)
    return {"file": path.name, "bytes": path.stat().st_size, "sha256": h.hexdigest()}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--project", required=True)
    p.add_argument("--key-status", type=Path, required=True)
    p.add_argument("--ca-file", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--apply", action="store_true")
    args = p.parse_args()
    if not re.fullmatch(r"[a-z]{20}", args.project):
        raise ValueError("Invalid project reference")
    status = json.loads(args.key_status.read_text())
    if status.get("vault_status") != "saved-and-downloaded-key-recovery-verified":
        raise ValueError("Verified vault recovery key required")
    public = args.key_status.parent / "recovery-public-key.asc"
    if hashlib.sha256(public.read_bytes()).hexdigest() != status["public_key_sha256"]:
        raise ValueError("Recovery public key changed")
    output = args.output.resolve()
    allowed = (Path.home() / ".local/state/sagerock-recovery/backups").resolve()
    if not output.is_relative_to(allowed) or output == allowed or output.exists():
        raise ValueError("A NEW private recovery backup directory is required")
    if not args.apply:
        print(json.dumps({"mode": "plan", "project": args.project, "output": str(output),
                          "key_fingerprint": status["fingerprint"], "upload": False}))
        return
    output.mkdir(parents=True, mode=0o700)
    started = datetime.now(timezone.utc).isoformat()
    fingerprint = status["fingerprint"]
    artifacts = []
    # Kept outside the backup directory; no temporary login or secret recovery key
    # is included in the archive. Connections established before expiry survive it.
    with tempfile.TemporaryDirectory(prefix="recovery-export-auth-") as temporary:
        temp = Path(temporary)
        home = temp / "gpg"
        home.mkdir(mode=0o700)
        subprocess.run(["gpg", "--homedir", str(home), "--batch", "--import", str(public)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        conn = None
        try:
            poolers = management(args.project, "config/database/pooler")
            primary = next(x for x in poolers if x["database_type"] == "PRIMARY")
            host = primary["db_host"]
            if not host.endswith(".pooler.supabase.com"):
                raise ValueError("Unexpected database host")
            login = management(args.project, "cli/login-role", {"read_only": False})
            user = login["role"] + "." + args.project
            params = dict(host=host, port=5432, user=user, password=login["password"],
                          dbname="postgres", sslmode="verify-full", sslrootcert=str(args.ca_file.resolve()),
                          connect_timeout=20, application_name="sagerock-supervised-backup")
            conn = psycopg2.connect(**params)
            if not conn.info.ssl_in_use:
                raise ValueError("Encrypted connection required")
            conn.set_session(isolation_level="REPEATABLE READ", readonly=True)
            cur = conn.cursor()
            cur.execute("SET LOCAL ROLE postgres; SET LOCAL statement_timeout='120s'; SET LOCAL lock_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='35min'")
            cur.execute("SELECT pg_export_snapshot(), current_setting('transaction_read_only'), current_setting('server_version_num')")
            snapshot, readonly, version = cur.fetchone()
            if readonly != "on" or int(version) // 10000 != 17:
                raise ValueError("Read-only PostgreSQL 17 snapshot required")
            def escape(value):
                return str(value).replace("\\", "\\\\").replace(":", "\\:")
            password_file = temp / "pgpass"
            password_file.write_text(":".join(map(escape, [host, 5432, "postgres", user, login["password"]])) + "\n")
            os.chmod(password_file, 0o600)
            env = {k: v for k, v in os.environ.items() if not k.startswith("PG")}
            env.update(PGHOST=host, PGPORT="5432", PGUSER=user, PGDATABASE="postgres",
                       PGPASSFILE=str(password_file), PGSSLMODE="verify-full", PGSSLROOTCERT=str(args.ca_file.resolve()),
                       PGCONNECT_TIMEOUT="20", PGAPPNAME="sagerock-supervised-backup")
            print("Verified TLS and read-only database snapshot; exporting encrypted archives.", flush=True)
            artifacts.append(encrypt(output / "roles.sql.gpg", home, fingerprint,
                command=[str(BIN / "pg_dumpall"), "--roles-only", "--no-role-passwords", "--no-password", "--role=postgres"], env=env))
            artifacts.append(encrypt(output / "database.dump.gpg", home, fingerprint,
                command=[str(BIN / "pg_dump"), "--format=custom", "--compress=gzip:6", "--no-password",
                         "--role=postgres", "--lock-wait-timeout=5s", "--snapshot=" + snapshot], env=env))
            # Evidence is collected in the SAME snapshot as the database dump.
            cur.execute("SELECT n.nspname,c.relname,c.relrowsecurity,c.relforcerowsecurity,c.relacl::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' ORDER BY 1,2")
            tables = cur.fetchall()
            evidence = []
            for schema, table, rls, force_rls, acl in tables:
                cur.execute(sql.SQL("SELECT count(*) FROM {}.{}").format(sql.Identifier(schema), sql.Identifier(table)))
                evidence.append(dict(schema=schema, table=table, rows=cur.fetchone()[0], rls=rls, force_rls=force_rls, acl=acl))
            samples = {}
            for table in ["clients", "contacts", "knowledge_bases", "email_conversations", "admin_users"]:
                cur.execute(sql.SQL("SELECT md5(coalesce(string_agg(to_jsonb(s)::text,E'\\n' ORDER BY to_jsonb(s)::text),'')) FROM (SELECT * FROM public.{} ORDER BY id LIMIT 5) s").format(sql.Identifier(table)))
                samples[table] = cur.fetchone()[0]
            cur.execute("SELECT extname,extversion FROM pg_extension ORDER BY extname")
            extensions = cur.fetchall()
            metadata = dict(started_at=started, project=args.project, snapshot=snapshot, version=version,
                            ssl_verified=True, read_only=True, tables=evidence, sample_hashes=samples, extensions=extensions,
                            role_passwords_included=False, roles_same_snapshot=False,
                            coverage_limits=["Roles are a separate catalog read", "No Storage/S3 media bytes", "No local AI knowledge", "No complete runtime/secret inventory"])
            artifacts.append(encrypt(output / "snapshot-evidence.json.gpg", home, fingerprint,
                                     data=json.dumps(metadata, default=str).encode()))
            conn.rollback()
            # Vault's root key is necessary if encrypted Vault records are used.
            vault_config = management(args.project, "pgsodium")
            if not re.fullmatch(r"[0-9a-fA-F]{64}", vault_config.get("root_key", "")):
                raise ValueError("Vault recovery root key missing")
            artifacts.append(encrypt(output / "vault-recovery.json.gpg", home, fingerprint,
                                     data=json.dumps(vault_config).encode()))
            private_json(output / "manifest.json", dict(status="encrypted-export-complete", started_at=started,
                finished_at=datetime.now(timezone.utc).isoformat(), project=args.project, fingerprint=fingerprint,
                artifacts=artifacts, table_count=len(tables), uploaded=False, restore_verified=False,
                scope="logical database, role definitions without passwords, Vault recovery root; excludes media, local knowledge and runtime configuration"))
            print(json.dumps({"status": "encrypted-export-complete", "directory": str(output),
                              "artifacts": len(artifacts), "encrypted_bytes": sum(x["bytes"] for x in artifacts),
                              "tables": len(tables), "uploaded": False}, indent=2))
        finally:
            if conn:
                conn.close()
            subprocess.run(["gpgconf", "--homedir", str(home), "--kill", "all"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # Driver exceptions may include connection parameters or source values.
        if isinstance(exc, (ValueError, RuntimeError)):
            raise SystemExit(str(exc))
        raise SystemExit("Backup failed (" + type(exc).__name__ + "); not marked complete") from None
