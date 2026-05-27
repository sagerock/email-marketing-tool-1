"""
Writes current Renewal enrollment counts from Supabase to the CfA Google Sheet.
Runs after sync.py in the nightly Railway cron.

Looks up each row by its label in column A so that adding, removing, or
reordering rows on the sheet doesn't misalign the data. Also fills the two
total rows Elsy added.

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

SHEET_ID = os.environ.get("GOOGLE_SHEET_ID", "")
CFA_CLIENT_ID = "22500cd6-052a-42ff-a0cb-4f3ba9125dfd"
WORKSHEET_NAME = "Enrollment by Grade"

# Maps the shorter labels Elsy uses on the sheet to the Supabase program name.
SHEET_TO_SUPABASE_NAME = {
    "Community Gatherings Only": "Morning Community Gatherings Only - Renewal 2026 Online",
}

TOTAL_IN_PERSON_LABEL = "Total In-Person"
TOTAL_ONLINE_LABEL = "Total-Online"
TOTAL_LABELS = {TOTAL_IN_PERSON_LABEL, TOTAL_ONLINE_LABEL}


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


def _empty_count() -> dict:
    return {"registered": 0, "cancelled": 0, "waitlisted": 0}


def _sum_counts(items: list) -> dict:
    total = _empty_count()
    for c in items:
        for k in total:
            total[k] += c.get(k, 0)
    return total


def _row_values(c: dict, updated_at: str) -> list:
    return [str(c["registered"]), str(c["cancelled"]), str(c["waitlisted"]), updated_at]


def build_updates(counts: dict, label_to_row: dict, updated_at: str) -> list:
    """Return a list of {range, values} dicts to write to the sheet.

    counts: {supabase_program_name: {registered, cancelled, waitlisted}}
    label_to_row: {sheet_column_A_label: 1-indexed_row}
    """
    updates = []
    written_in_person = []
    written_online = []

    for label, row in label_to_row.items():
        if label in TOTAL_LABELS:
            continue
        supabase_name = SHEET_TO_SUPABASE_NAME.get(label, label)
        if supabase_name not in counts:
            continue
        c = counts[supabase_name]
        updates.append({"range": f"C{row}:F{row}", "values": [_row_values(c, updated_at)]})
        if "In-Person" in supabase_name:
            written_in_person.append(c)
        elif "Online" in supabase_name:
            written_online.append(c)

    if TOTAL_IN_PERSON_LABEL in label_to_row:
        r = label_to_row[TOTAL_IN_PERSON_LABEL]
        updates.append({"range": f"C{r}:F{r}", "values": [_row_values(_sum_counts(written_in_person), updated_at)]})
    if TOTAL_ONLINE_LABEL in label_to_row:
        r = label_to_row[TOTAL_ONLINE_LABEL]
        updates.append({"range": f"C{r}:F{r}", "values": [_row_values(_sum_counts(written_online), updated_at)]})

    return updates


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

    print("Opening sheet and reading current row layout...")
    ws = get_sheet(SHEET_ID)
    program_col = ws.col_values(1)
    label_to_row = {label.strip(): i + 1 for i, label in enumerate(program_col) if label.strip()}

    updates = build_updates(counts, label_to_row, updated_at)

    total_registered = sum(c["registered"] for c in counts.values())
    print(f"  {total_registered} total registered across {len(counts)} Supabase programs")
    print(f"Writing {len(updates)} row(s) to Google Sheet...")
    ws.batch_update(updates, value_input_option="USER_ENTERED")

    print(f"Sheet updated. ({updated_at})")


if __name__ == "__main__":
    main()
