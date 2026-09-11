#!/usr/bin/env bash
# Synthetic data ONLY. No production credentials, URLs, network listeners or app workers.
set -euo pipefail
umask 077
recovery_bin=/usr/lib/postgresql/16/bin
for recovery_command in initdb pg_ctl pg_dump pg_dumpall pg_restore psql createdb; do
  test -x "$recovery_bin/$recovery_command"
done
command -v gpg >/dev/null
recovery_scripts=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
recovery_root=$(mktemp -d /tmp/email-recovery-drill.XXXXXXXX)
mkdir "$recovery_root/source-socket" "$recovery_root/target-socket" "$recovery_root/keys"
export GNUPGHOME="$recovery_root/keys"
# Discard inherited libpq settings: this drill can only reach its own Unix sockets.
unset PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGPASSWORD PGPASSFILE PGSERVICE PGSERVICEFILE PGOPTIONS PGSSLROOTCERT
recovery_cleanup() {
  "$recovery_bin/pg_ctl" -D "$recovery_root/source" stop -m fast >/dev/null 2>&1 || true
  "$recovery_bin/pg_ctl" -D "$recovery_root/target" stop -m fast >/dev/null 2>&1 || true
  gpgconf --homedir "$GNUPGHOME" --kill all >/dev/null 2>&1 || true
  # Retain this uniquely named synthetic fixture for inspection; never erase a shared tree.
  printf 'Synthetic artifacts retained at %s; database servers stopped.\n' "$recovery_root"
}
trap recovery_cleanup EXIT
"$recovery_bin/initdb" -D "$recovery_root/source" -U postgres --auth=trust >/dev/null
"$recovery_bin/initdb" -D "$recovery_root/target" -U restore_owner --auth=trust >/dev/null
"$recovery_bin/pg_ctl" -D "$recovery_root/source" -l "$recovery_root/source.log" -o "-h '' -k $recovery_root/source-socket" start >/dev/null
"$recovery_bin/pg_ctl" -D "$recovery_root/target" -l "$recovery_root/target.log" -o "-h '' -k $recovery_root/target-socket" start >/dev/null
"$recovery_bin/createdb" -h "$recovery_root/source-socket" -U postgres security_hardening_test
"$recovery_bin/psql" -X -h "$recovery_root/source-socket" -U postgres -d security_hardening_test -v ON_ERROR_STOP=1 -f "$recovery_scripts/test-security-hardening.sql" >"$recovery_root/fixture.log" 2>&1
"$recovery_bin/psql" -X -h "$recovery_root/source-socket" -U postgres -d security_hardening_test -v ON_ERROR_STOP=1 -f "$recovery_scripts/test-privileged-functions.sql" >>"$recovery_root/fixture.log" 2>&1

# This disposable unprotected key is ONLY for synthetic data, not a recovery key.
gpg --batch --pinentry-mode loopback --passphrase '' --quick-generate-key 'Synthetic Recovery <recovery@example.invalid>' rsa2048 encr 1d >"$recovery_root/key.log" 2>&1
"$recovery_bin/pg_dumpall" -h "$recovery_root/source-socket" -U postgres --roles-only --no-role-passwords \
  | gpg --batch --encrypt --recipient recovery@example.invalid >"$recovery_root/roles.sql.gpg"
"$recovery_bin/pg_dump" -h "$recovery_root/source-socket" -U postgres -d security_hardening_test --format=custom \
  | gpg --batch --encrypt --recipient recovery@example.invalid >"$recovery_root/database.dump.gpg"
# A damaged encrypted copy must fail its integrity check. Never feed this copy to restore.
head -c -32 "$recovery_root/database.dump.gpg" >"$recovery_root/truncated.dump.gpg"
if gpg --batch --decrypt "$recovery_root/truncated.dump.gpg" >/dev/null 2>"$recovery_root/truncated.log"; then
  printf 'FAIL: truncated encrypted archive unexpectedly passed integrity verification.\n' >&2
  exit 1
fi
# Verify BOTH complete archives before executing any restored SQL. A streaming
# decrypt can emit plaintext before it detects corruption at the end; pipefail
# alone cannot undo SQL already consumed by psql or pg_restore.
for recovery_archive in roles.sql.gpg database.dump.gpg; do
  gpg --batch --decrypt "$recovery_root/$recovery_archive" >/dev/null 2>>"$recovery_root/integrity.log"
done
# No plaintext backup files: decrypt verified archives into a NEW isolated cluster.
gpg --batch --decrypt "$recovery_root/roles.sql.gpg" 2>"$recovery_root/decrypt.log" \
  | "$recovery_bin/psql" -X -h "$recovery_root/target-socket" -U restore_owner -d postgres -v ON_ERROR_STOP=1 >"$recovery_root/roles-restore.log"
"$recovery_bin/createdb" -h "$recovery_root/target-socket" -U restore_owner -O postgres security_hardening_test
gpg --batch --decrypt "$recovery_root/database.dump.gpg" 2>>"$recovery_root/decrypt.log" \
  | "$recovery_bin/pg_restore" -h "$recovery_root/target-socket" -U restore_owner -d security_hardening_test --exit-on-error --single-transaction
"$recovery_bin/psql" -X -h "$recovery_root/target-socket" -U postgres -d security_hardening_test -v ON_ERROR_STOP=1 -f "$recovery_scripts/test-restored-security.sql"
printf 'PASS: encrypted synthetic database and roles restored into a separate cluster.\n'
