#!/usr/bin/env python3
"""Internal recovery verifier. Run ONLY inside the documented filesystem/network sandbox.

Fixed mounts: /input = S3 ciphertext readback, /key/kit.json = verified vault kit,
/opt/pg17 = isolated PostgreSQL tool distribution, /work = new private scratch.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import uuid

import psycopg2
from psycopg2 import sql


def verify_client_boundaries(conn):
    """Exercise restored policies against real rows with temporary test users.

    All fixture inserts and the default-privilege probe are rolled back. No source
    identities/record values are printed and no migrations are reapplied.
    """
    conn.rollback()
    conn.set_session(readonly=False)
    cur = conn.cursor()
    tables = ["contacts", "contact_notes", "contact_tasks", "knowledge_bases", "email_conversations",
              "discovered_media_urls", "cc_contacts", "cc_lists", "cc_list_memberships", "sync_runs"]
    try:
        cur.execute("SELECT client_id FROM public.contacts GROUP BY client_id HAVING count(*)>0 ORDER BY count(*) DESC LIMIT 2")
        clients = [str(row[0]) for row in cur.fetchall()]
        if len(clients) != 2 or "None" in clients:
            raise ValueError("Two populated clients required for isolation verification")
        expected = {}
        for table in tables:
            for client_id in clients:
                cur.execute(sql.SQL("SELECT count(*) FROM public.{} WHERE client_id=%s").format(sql.Identifier(table)), (client_id,))
                expected[table, client_id] = cur.fetchone()[0]
        for client_id in clients:
            user_id = str(uuid.uuid4())
            email = user_id + "@recovery-test.invalid"
            cur.execute("INSERT INTO auth.users(id,email) VALUES (%s,%s)", (user_id, email))
            cur.execute("INSERT INTO public.admin_users(user_id,email,role,client_id) VALUES (%s,%s,'client_admin',%s)",
                        (user_id, email, client_id))
            cur.execute("SET LOCAL ROLE authenticated")
            cur.execute("SELECT set_config('request.jwt.claim.sub',%s,true),set_config('request.jwt.claims',%s,true)",
                        (user_id, json.dumps({"sub": user_id, "role": "authenticated"})))
            for table in tables:
                cur.execute(sql.SQL("SELECT count(*),count(*) FILTER (WHERE client_id IS DISTINCT FROM %s::uuid) FROM public.{}").format(sql.Identifier(table)), (client_id,))
                if cur.fetchone() != (expected[table, client_id], 0):
                    raise ValueError("Restored client boundary mismatch: " + table)
            other = next(x for x in clients if x != client_id)
            cur.execute("SELECT coalesce(sum(cnt),0) FROM public.get_tag_counts(%s,ARRAY[]::text[])", (other,))
            if cur.fetchone()[0] != 0:
                raise ValueError("Restored tag RPC crossed client boundary")
            cur.execute("RESET ROLE")
        cur.execute("SET LOCAL ROLE anon")
        cur.execute("SAVEPOINT anonymous_probe")
        try:
            cur.execute("SELECT count(*) FROM public.knowledge_bases")
        except psycopg2.errors.InsufficientPrivilege:
            cur.execute("ROLLBACK TO SAVEPOINT anonymous_probe")
        else:
            raise ValueError("Anonymous knowledge access allowed")
        cur.execute("RESET ROLE")
        cur.execute("SET LOCAL ROLE postgres")
        cur.execute("CREATE FUNCTION public.recovery_default_privilege_probe() RETURNS integer LANGUAGE sql AS 'SELECT 1'")
        cur.execute("SELECT has_function_privilege('anon','public.recovery_default_privilege_probe()','EXECUTE'),has_function_privilege('authenticated','public.recovery_default_privilege_probe()','EXECUTE'),has_function_privilege('service_role','public.recovery_default_privilege_probe()','EXECUTE')")
        if cur.fetchone() != (False, False, True):
            raise ValueError("Restored future function defaults differ")
        return {"clients_tested": 2, "tables_per_client": len(tables), "cross_client_tag_rpc_denied": True,
                "anonymous_knowledge_denied": True, "future_function_defaults_verified": True,
                "fixtures_rolled_back": True}
    finally:
        conn.rollback()


def main():
    if os.environ.get("RECOVERY_ISOLATED") != "1" or Path("/home/sage/.aws").exists():
        raise ValueError("Recovery sandbox required")
    if len(Path("/proc/net/route").read_text().splitlines()) != 1:
        raise ValueError("Network isolation required")
    work = Path("/work")
    kit = json.loads(Path("/key/kit.json").read_text())
    home = work / "gnupg"
    home.mkdir(mode=0o700)
    server = Path("/opt/pg17/usr/lib/postgresql/17/bin")
    client = Path("/usr/lib/postgresql/17/bin")
    started = time.monotonic()
    pgdata = work / "pgdata"
    socket = work / "socket"
    socket.mkdir(mode=0o700)
    started_server = False
    log = (work / "restore-private.log").open("xb")
    def gpg(name=None, data=None, extra=()):
        command = ["gpg", "--homedir", str(home), "--batch", "--no-tty"]
        if name:
            command += ["--pinentry-mode", "loopback", "--passphrase-fd", "0", "--decrypt", "/input/" + name]
            data = (kit["private_key_passphrase"] + "\n").encode()
        command += list(extra)
        return subprocess.run(command, input=data, stdout=subprocess.PIPE, stderr=log, check=True)
    def run(args):
        return subprocess.run([str(x) for x in args], stdout=log, stderr=log, check=True)
    def restore_stream(name, command):
        dec = subprocess.Popen(["gpg", "--homedir", str(home), "--batch", "--no-tty",
            "--pinentry-mode", "loopback", "--passphrase-fd", "0", "--decrypt", "/input/" + name],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log)
        restore = subprocess.Popen([str(x) for x in command], stdin=dec.stdout, stdout=log, stderr=log)
        dec.stdout.close()
        dec.stdin.write((kit["private_key_passphrase"] + "\n").encode())
        dec.stdin.close()
        try:
            restored = restore.wait(timeout=1800)
            decrypted = dec.wait(timeout=60)
            if restored or decrypted:
                raise RuntimeError("Restore stream failed: " + name)
        finally:
            for proc in [restore, dec]:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait()
    try:
        gpg(data=kit["private_key_armored"].encode(), extra=["--import"])
        # Fully verify every ciphertext BEFORE any SQL is executed; don't rely on
        # streaming exit codes to undo SQL that was already consumed.
        for name in ["roles.sql.gpg", "database.dump.gpg", "snapshot-evidence.json.gpg", "vault-recovery.json.gpg", "manifest.json.gpg"]:
            r = subprocess.run(["gpg", "--homedir", str(home), "--batch", "--no-tty",
                "--pinentry-mode", "loopback", "--passphrase-fd", "0", "--decrypt", "/input/" + name],
                input=(kit["private_key_passphrase"] + "\n").encode(), stdout=subprocess.DEVNULL, stderr=log)
            if r.returncode:
                raise RuntimeError("Archive integrity failure: " + name)
        manifest = json.loads(gpg("manifest.json.gpg").stdout)
        for a in manifest["artifacts"]:
            if Path(a["file"]).name != a["file"]:
                raise ValueError("Invalid manifest path")
            h = hashlib.sha256()
            with (Path("/input") / a["file"]).open("rb") as inp:
                for part in iter(lambda: inp.read(1024 * 1024), b""):
                    h.update(part)
            if h.hexdigest() != a["sha256"]:
                raise ValueError("Encrypted manifest hash mismatch")
        evidence = json.loads(gpg("snapshot-evidence.json.gpg").stdout)
        vault = json.loads(gpg("vault-recovery.json.gpg").stdout)
        root = work / "vault-root"
        root.write_text(vault["root_key"] + "\n")
        root.chmod(0o600)
        getkey = work / "get-vault-key"
        getkey.write_text("#!/bin/sh\nexec cat /work/vault-root\n")
        getkey.chmod(0o700)
        # PG17 role grants preserve the bootstrap grantor. Match Supabase's
        # bootstrap role; omit only its duplicate CREATE in the roles archive.
        roles = gpg("roles.sql.gpg").stdout
        bootstrap_create = b"CREATE ROLE supabase_admin;\n"
        if roles.count(bootstrap_create) != 1:
            raise ValueError("Expected Supabase bootstrap role definition required")
        roles = roles.replace(bootstrap_create, b"", 1)
        run([server / "initdb", "-D", pgdata, "-U", "supabase_admin", "--auth=trust", "--locale=C.UTF-8"])
        with (pgdata / "postgresql.conf").open("a") as config:
            config.write("\nlisten_addresses=''\nunix_socket_directories='/work/socket'\n")
            config.write("shared_preload_libraries='pg_cron,supabase_vault'\ncron.database_name='recovery_test'\ncron.launch_active_jobs=off\n")
            config.write("vault.getkey_script='/work/get-vault-key'\njit=off\nmax_connections=10\nshared_buffers='128MB'\n")
            config.write("log_statement='none'\nlog_min_error_statement=panic\n")
        run([server / "pg_ctl", "-D", pgdata, "-l", work / "postgres-private.log", "start"])
        started_server = True
        subprocess.run([str(client / "psql"), "-X", "-w", "-h", str(socket), "-U", "supabase_admin",
                       "-d", "postgres", "-v", "ON_ERROR_STOP=1", "--single-transaction"],
                       input=roles, stdout=log, stderr=log, check=True, timeout=60)
        run([client / "createdb", "-h", socket, "-U", "supabase_admin", "-O", "postgres", "recovery_test"])
        restore_stream("database.dump.gpg", [client / "pg_restore", "-h", socket, "-U", "supabase_admin",
                       "-d", "recovery_test", "--exit-on-error", "--single-transaction"])
        conn = psycopg2.connect(host=str(socket), user="supabase_admin", dbname="recovery_test")
        conn.set_session(readonly=True)
        cur = conn.cursor()
        for t in evidence["tables"]:
            cur.execute(sql.SQL("SELECT count(*) FROM {}.{}").format(sql.Identifier(t["schema"]), sql.Identifier(t["table"])))
            if cur.fetchone()[0] != t["rows"]:
                raise ValueError("Restored table count mismatch: " + t["schema"] + "." + t["table"])
            cur.execute("SELECT relrowsecurity,relforcerowsecurity,coalesce(relacl,acldefault('r',relowner))::text,acldefault('r',relowner)::text FROM pg_class WHERE oid=%s::regclass",
                        (sql.Identifier(t["schema"], t["table"]).as_string(conn),))
            rls, force, acl, default_acl = cur.fetchone()
            if rls != t["rls"] or force != t["force_rls"]:
                raise ValueError("Restored RLS mismatch")
            # pg_dump omits an explicit owner-only ACL equal to the default.
            # Normalize NULL via acldefault; order is not significant.
            source_acl = t["acl"] if t["acl"] is not None else default_acl
            if set(acl.strip("{}").split(",")) != set(source_acl.strip("{}").split(",")):
                raise ValueError("Restored table ACL mismatch: " + t["schema"] + "." + t["table"])
        for table, expected in evidence["sample_hashes"].items():
            cur.execute(sql.SQL("SELECT md5(coalesce(string_agg(to_jsonb(s)::text,E'\\n' ORDER BY to_jsonb(s)::text),'')) FROM (SELECT * FROM public.{} ORDER BY id LIMIT 5) s").format(sql.Identifier(table)))
            if cur.fetchone()[0] != expected:
                raise ValueError("Restored sample hash mismatch: " + table)
        cur.execute("SELECT has_function_privilege('anon','public.execute_sql(text)','EXECUTE'),has_function_privilege('authenticated','public.execute_sql(text)','EXECUTE'),has_function_privilege('service_role','public.execute_sql(text)','EXECUTE')")
        if cur.fetchone() != (False, False, True):
            raise ValueError("Restored privileged RPC access differs")
        cur.execute("SELECT extname,extversion FROM pg_extension ORDER BY extname")
        restored_extensions = cur.fetchall()
        cur.execute("SELECT current_setting('cron.launch_active_jobs'),current_setting('listen_addresses')")
        if cur.fetchone() != ("off", ""):
            raise ValueError("Recovery service isolation failed")
        client_boundaries = verify_client_boundaries(conn)
        conn.close()
        result = dict(status="database-restore-verified", tables_verified=len(evidence["tables"]),
            sample_tables_verified=len(evidence["sample_hashes"]), table_rls_and_acls_verified=True,
            privileged_rpc_boundary_verified=True, network_isolated=True, filesystem_isolated=True,
            scheduler_disabled=True, elapsed_seconds=round(time.monotonic() - started, 1),
            source_extensions=evidence["extensions"], restored_extensions=restored_extensions,
            client_boundaries=client_boundaries,
            limits=["Same desktop", "No hosted Supabase/Auth API application smoke test", "No media, local knowledge or full runtime backup"])
        (work / "verification.json").write_text(json.dumps(result, indent=2))
        print(json.dumps(result, indent=2))
    finally:
        if started_server:
            subprocess.run([str(server / "pg_ctl"), "-D", str(pgdata), "stop", "-m", "fast"], stdout=log, stderr=log)
        subprocess.run(["gpgconf", "--homedir", str(home), "--kill", "all"], stdout=log, stderr=log)
        log.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        if isinstance(exc, (ValueError, RuntimeError)):
            raise SystemExit(str(exc))
        raise SystemExit("Isolated restore failed: " + type(exc).__name__ + "; inspect private diagnostic logs") from None
