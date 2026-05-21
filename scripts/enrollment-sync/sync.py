import argparse
import json
import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

import db
from connectors import cvent

CONFIG_DIR = Path(__file__).parent / "config"

STATUS_MAP = {
    "Registered": "registered",
    "Cancelled": "cancelled",
    "Waitlisted": "waitlisted",
}


def load_config(client_name: str) -> dict:
    path = CONFIG_DIR / f"{client_name}.json"
    if not path.exists():
        raise FileNotFoundError(f"No config found for client '{client_name}' at {path}")
    with open(path) as f:
        return json.load(f)


def sync_cvent_session(sb, config: dict, session_id: str, dry_run: bool = False) -> None:
    session_config = config["sessions"][session_id]
    event_id = config["cvent_event_id"]
    client_id = config["client_id"]

    print(f"  Authenticating with Cvent...")
    token = cvent.get_token()

    print(f"  Fetching attendees for event {event_id}...")
    all_attendees = cvent.fetch_attendees(token, event_id)

    print(f"  Fetching enrollments for session {session_id}...")
    enrollments = cvent.fetch_session_enrollments(token, session_id)
    print(f"  {len(enrollments)} enrollments found")

    if not dry_run:
        program_id = db.upsert_program(
            sb,
            client_id=client_id,
            name=session_config["name"],
            year=session_config["year"],
            program_format=session_config["format"],
            platform="cvent",
            platform_id=session_id,
            tag=session_config["tag"],
            instructor=session_config.get("instructor"),
        )

    for enr in enrollments:
        att_id = enr["attendee"]["id"]
        att = all_attendees.get(att_id)
        if not att:
            print(f"  WARNING: attendee {att_id} not found in event roster, skipping")
            continue

        status = STATUS_MAP.get(enr.get("status"), "registered")
        name = f"{att['firstName']} {att['lastName']}"

        if dry_run:
            print(f"  [DRY RUN] {name} <{att['email']}> → {session_config['name']} ({status})")
            continue

        contact_id = db.upsert_contact(sb, client_id, att["email"], att["firstName"], att["lastName"])
        db.upsert_enrollment(
            sb,
            client_id=client_id,
            program_id=program_id,
            contact_id=contact_id,
            status=status,
            enrolled_at=enr.get("registrationDate"),
            platform_enrollment_id=enr["id"],
            raw_data=enr,
        )
        if status == "registered":
            db.apply_tag(sb, contact_id, session_config["tag"])

    if not dry_run:
        print(f"  Done: {len(enrollments)} enrollments synced")


def main() -> None:
    parser = argparse.ArgumentParser(description="Sync course enrollments into the mail tool database")
    parser.add_argument("--client", required=True, help="Client config name (e.g. cfa)")
    parser.add_argument("--platform", required=True, choices=["cvent"])
    parser.add_argument("--program-id", help="Single session ID to sync")
    parser.add_argument("--all-sessions", action="store_true", help="Sync all sessions in config")
    parser.add_argument("--dry-run", action="store_true", help="Print what would sync without writing")
    args = parser.parse_args()

    config = load_config(args.client)

    if args.dry_run:
        print("DRY RUN — no data will be written\n")
        sb = None
    else:
        sb = db.get_supabase()

    if args.platform == "cvent":
        session_ids = (
            list(config["sessions"].keys()) if args.all_sessions
            else [args.program_id]
        )
        if not session_ids or session_ids == [None]:
            parser.error("Provide --program-id or --all-sessions")

        for session_id in session_ids:
            if session_id not in config["sessions"]:
                print(f"WARNING: session {session_id} not in config, skipping")
                continue
            print(f"\nSyncing: {config['sessions'][session_id]['name']}")
            sync_cvent_session(sb, config, session_id, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
