"""
Writes current Renewal enrollment counts from Supabase to the CfA Google Sheet.
Runs after sync.py in the nightly Railway cron.

Requires env vars:
    SUPABASE_URL, SUPABASE_SERVICE_KEY
    GOOGLE_SERVICE_ACCOUNT_JSON  (full JSON key as a single-line string)
    GOOGLE_SHEET_ID              (spreadsheet ID)
"""

import json
import os
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from google.oauth2.service_account import Credentials
import gspread
from supabase import create_client

load_dotenv(Path(__file__).parent / ".env")

SHEET_ID = os.environ["GOOGLE_SHEET_ID"]
CFA_CLIENT_ID = "22500cd6-052a-42ff-a0cb-4f3ba9125dfd"
WORKSHEET_NAME = "Enrollment by Grade"

# Row order must match the sheet layout set up in the headers
PROGRAM_ROW_ORDER = [
    "Grade 1 Teaching - Renewal 2026 In-Person",
    "Grade 2 Teaching - Renewal 2026 In-Person",
    "Grade 3 Teaching - Renewal 2026 In-Person",
    "Grade 4 Teaching - Renewal 2026 In-Person",
    "Grade 5 Teaching - Renewal 2026 In-Person",
    "Grade 6 Teaching - Renewal 2026 In-Person",
    "Grade 7 Teaching - Renewal 2026 In-Person",
    "Grade 8 Teaching - Renewal 2026 In-Person",
    "Movement Education and Renewal Through the Grades - Renewal 2026 In-Person",
    "Teaching Special Subjects - Renewal 2026 In-Person",
    "Grade 1 Teaching - Renewal 2026 Online",
    "Grade 2 Teaching - Renewal 2026 Online",
    "Grade 3 Teaching - Renewal 2026 Online",
    "Grade 4 Teaching - Renewal 2026 Online",
    "Grade 5 Teaching - Renewal 2026 Online",
    "Grade 6 Teaching - Renewal 2026 Online",
    "Grade 7 Teaching - Renewal 2026 Online",
    "Grade 8 Teaching - Renewal 2026 Online",
]


def fetch_counts(sb) -> dict:
    """Return {program_name: {registered, cancelled, waitlisted}} from Supabase."""
    programs = sb.table("programs").select("id,name").eq("client_id", CFA_CLIENT_ID).execute().data
    counts = {p["name"]: {"registered": 0, "cancelled": 0, "waitlisted": 0} for p in programs}
    program_ids = {p["id"]: p["name"] for p in programs}

    enrollments = sb.table("enrollments").select("program_id,status").eq("client_id", CFA_CLIENT_ID).execute().data
    for enr in enrollments:
        name = program_ids.get(enr["program_id"])
        if name and name in counts:
            status = enr["status"]
            if status in counts[name]:
                counts[name][status] += 1

    return counts


def build_rows(counts: dict, updated_at: str) -> list:
    """Build data rows in sheet order."""
    rows = []
    for program_name in PROGRAM_ROW_ORDER:
        c = counts.get(program_name, {"registered": 0, "cancelled": 0, "waitlisted": 0})
        rows.append([
            str(c["registered"]),
            str(c["cancelled"]),
            str(c["waitlisted"]),
            updated_at,
        ])
    return rows


def get_sheet(sheet_id: str):
    creds_json = json.loads(os.environ["GOOGLE_SERVICE_ACCOUNT_JSON"])
    creds = Credentials.from_service_account_info(
        creds_json,
        scopes=["https://www.googleapis.com/auth/spreadsheets"],
    )
    gc = gspread.authorize(creds)
    return gc.open_by_key(sheet_id).worksheet(WORKSHEET_NAME)


def main() -> None:
    print("Connecting to Supabase...")
    sb = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_KEY"])

    print("Fetching enrollment counts...")
    counts = fetch_counts(sb)

    updated_at = datetime.now(timezone.utc).strftime("%-d %b %Y %H:%M UTC")
    rows = build_rows(counts, updated_at)

    total_registered = sum(counts.get(p, {}).get("registered", 0) for p in PROGRAM_ROW_ORDER)
    print(f"  {total_registered} total registered across {len(PROGRAM_ROW_ORDER)} programs")

    print("Writing to Google Sheet...")
    ws = get_sheet(SHEET_ID)
    ws.update(f"C2:F{1 + len(PROGRAM_ROW_ORDER)}", rows)

    print(f"Sheet updated. ({updated_at})")


if __name__ == "__main__":
    main()
