"""One-time seed of cc_sync_state from an existing Constant Contact token file.

After this, the nightly sync owns token rotation. Re-run only if the sync ever
locks itself out and you need to re-seed from a fresh local authorization.

The token file is the gitignored cc-tokens.json produced by the CC OAuth flow,
e.g. clients/center-for-anthroposophy/constant-contact/cc-tokens.json — it must
contain at least access_token and refresh_token (expires_in optional).

Usage:
  python seed_cc_state.py --client cfa --tokens /path/to/cc-tokens.json
"""

import argparse
import json
import time
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(Path(__file__).parent / ".env")

import db


def load_config(client_name: str) -> dict:
    with open(Path(__file__).parent / "config" / f"{client_name}.json") as f:
        return json.load(f)


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed cc_sync_state from a CC token file")
    parser.add_argument("--client", required=True, help="Client config name (e.g. cfa)")
    parser.add_argument("--tokens", required=True, help="Path to cc-tokens.json")
    args = parser.parse_args()

    client_id = load_config(args.client)["client_id"]
    tok = json.loads(Path(args.tokens).read_text())

    # The stored token may already be expired; that is fine — the first sync run
    # sees it past expiry and refreshes before making any API call.
    expires_at = time.time() + int(tok.get("expires_in", 0))
    expires_iso = datetime.fromtimestamp(expires_at, tz=timezone.utc).isoformat()

    sb = db.get_supabase()
    sb.table("cc_sync_state").upsert(
        {
            "client_id": client_id,
            "access_token": tok["access_token"],
            "refresh_token": tok["refresh_token"],
            "token_expires_at": expires_iso,
            "updated_watermark": None,
            "last_run_status": "seeded",
        },
        on_conflict="client_id",
    ).execute()
    print(f"Seeded cc_sync_state for {args.client} ({client_id}).")


if __name__ == "__main__":
    main()
