"""Mirror Constant Contact contacts + lists into the cc_* tables.

This is Phase 1 of pulling CC in live: a one-way, read-only reflection. It does
NOT touch the `contacts` send list or apply any tags. Identity resolution into
the real people view is Phase 2.

Usage:
  python sync_cc.py --client cfa            # incremental (uses the saved watermark)
  python sync_cc.py --client cfa --full     # ignore watermark, pull everything
  python sync_cc.py --client cfa --dry-run  # fetch + count, write nothing

Seed the token row once before the first run (see seed_cc_state.py).
"""

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(Path(__file__).parent / ".env")

import db
from connectors import constant_contact as cc

CONFIG_DIR = Path(__file__).parent / "config"


def load_config(client_name: str) -> dict:
    path = CONFIG_DIR / f"{client_name}.json"
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        raise FileNotFoundError(f"No config found for client '{client_name}' at {path}")


def _to_epoch(ts) -> float:
    if not ts:
        return 0.0
    if isinstance(ts, (int, float)):
        return float(ts)
    return datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp()


def run(client_name: str, full: bool = False, dry_run: bool = False) -> None:
    config = load_config(client_name)
    client_id = config["client_id"]
    sb = db.get_supabase()

    state = db.get_cc_state(sb, client_id)
    if not state:
        raise SystemExit(
            f"No cc_sync_state row for client {client_id}. "
            f"Seed it first: python seed_cc_state.py --client {client_name} --tokens <cc-tokens.json>"
        )

    client = cc.CCClient(
        access_token=state.get("access_token"),
        refresh_token=state.get("refresh_token"),
        token_expires_at=_to_epoch(state.get("token_expires_at")),
        save_tokens=lambda **kw: db.save_cc_tokens(sb, client_id, **kw),
    )

    # 1) Lists first, so memberships have names to resolve against.
    lists = client.fetch_lists()
    print(f"Fetched {len(lists)} contact lists")
    if not dry_run:
        for lst in lists:
            db.upsert_cc_list(sb, client_id, lst)

    # 2) Contacts — incremental unless --full or there is no watermark yet.
    watermark = None if full else state.get("updated_watermark")
    mode = "FULL backfill" if not watermark else f"incremental since {watermark}"
    print(f"Syncing contacts ({mode})...")

    seen = 0
    max_updated = watermark
    for c in client.iter_contacts(updated_after=watermark):
        seen += 1
        updated = c.get("updated_at")
        if updated and (max_updated is None or updated > max_updated):
            max_updated = updated
        if dry_run:
            continue
        db.upsert_cc_contact(sb, client_id, c)
        db.replace_cc_memberships(sb, client_id, c.get("contact_id"), c.get("list_memberships") or [])

    print(f"  {seen} contacts mirrored")

    if not dry_run:
        db.save_cc_run(
            sb,
            client_id,
            updated_watermark=max_updated,
            last_run_at=datetime.now(timezone.utc).isoformat(),
            last_run_status=f"ok: {seen} contacts",
        )
        print("Done.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Mirror Constant Contact into the cc_* tables")
    parser.add_argument("--client", required=True, help="Client config name (e.g. cfa)")
    parser.add_argument("--full", action="store_true",
                        help="Ignore the watermark and pull everything (run weekly to catch deletes)")
    parser.add_argument("--dry-run", action="store_true", help="Fetch and count, but write nothing")
    args = parser.parse_args()
    run(args.client, full=args.full, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
