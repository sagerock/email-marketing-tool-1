"""
Writes the live CfA Renewal attendee roster from Supabase to a Google Sheet.
Runs after sync.py + sync_sheet.py in the nightly Railway cron.

Two tabs:
  - All Attendees: one row per registered attendee, sorted by session then last name.
  - Summary:      one row per session with the registered count.
                  Uses the column-A label pattern so Karen/Elsy can reorder
                  rows without misaligning the data.

Filters to status = 'registered' only — this roster drives name tags and
certificates, so cancellations and waitlist entries are excluded.

Requires env vars:
    SUPABASE_URL, SUPABASE_SERVICE_KEY
    GOOGLE_SERVICE_ACCOUNT_JSON  (full JSON key as a single-line string)
    GOOGLE_SHEET_ID_ROSTER       (spreadsheet ID of the new live-roster sheet)
"""

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from google.oauth2.service_account import Credentials
import gspread
from supabase import create_client

load_dotenv(Path(__file__).parent / ".env")

SHEET_ID = os.environ.get("GOOGLE_SHEET_ID_ROSTER", "")
CFA_CLIENT_ID = "22500cd6-052a-42ff-a0cb-4f3ba9125dfd"

ATTENDEES_TAB = "All Attendees"
SUMMARY_TAB = "Summary"
TOTAL_LABEL = "TOTAL"

# Order Karen uses on her sheet — drives sort order on All Attendees and
# the canonical Summary layout when the sheet is freshly created.
SESSION_ORDER = [
    "Grade 1 – Online", "Grade 2 – Online", "Grade 3 – Online", "Grade 4 – Online",
    "Grade 5 – Online", "Grade 6 – Online", "Grade 7 – Online", "Grade 8 – Online",
    "Grade 1 – In-Person", "Grade 2 – In-Person", "Grade 3 – In-Person", "Grade 4 – In-Person",
    "Grade 5 – In-Person", "Grade 6 – In-Person", "Grade 7 – In-Person", "Grade 8 – In-Person",
    "Special Subjects", "Movement Education", "Community Gatherings Only",
]
SESSION_RANK = {label: i for i, label in enumerate(SESSION_ORDER)}

# Map specific Supabase program names whose simple stripped form doesn't match Karen's labels.
PROGRAM_NAME_TO_LABEL = {
    "Teaching Special Subjects - Renewal 2026 In-Person": "Special Subjects",
    "Movement Education and Renewal Through the Grades - Renewal 2026 In-Person": "Movement Education",
    "Morning Community Gatherings Only - Renewal 2026 Online": "Community Gatherings Only",
}

# Normalize Supabase's lowercase format strings to Karen's Title Case.
FORMAT_DISPLAY = {"online": "Online", "in-person": "In-Person"}


def program_to_session_label(name: str) -> str | None:
    """Map a Supabase program name to Karen's session label, or None if unmapped."""
    if name in PROGRAM_NAME_TO_LABEL:
        return PROGRAM_NAME_TO_LABEL[name]
    m = re.match(r"^Grade (\d) Teaching - Renewal 2026 (In-Person|Online)$", name)
    if m:
        return f"Grade {m.group(1)} – {m.group(2)}"
    return None


def fetch_roster(sb) -> tuple[list[dict], dict[str, int]]:
    """Return (attendee_rows, counts_by_label).

    attendee_rows: [{"session", "type", "first_name", "last_name", "email"}], sorted.
    counts_by_label: {session_label: registered_count}
    """
    programs = sb.table("programs").select("id,name,format").eq("client_id", CFA_CLIENT_ID).execute().data
    program_by_id = {p["id"]: p for p in programs}

    enrollments = (
        sb.table("enrollments")
        .select("program_id,contact_id,status")
        .eq("client_id", CFA_CLIENT_ID)
        .eq("status", "registered")
        .execute()
        .data
    )

    contact_ids = list({e["contact_id"] for e in enrollments})
    contacts_by_id: dict[str, dict] = {}
    # Chunk to keep the IN-list short.
    for i in range(0, len(contact_ids), 500):
        chunk = contact_ids[i : i + 500]
        if not chunk:
            continue
        rows = sb.table("contacts").select("id,first_name,last_name,email").in_("id", chunk).execute().data
        for r in rows:
            contacts_by_id[r["id"]] = r

    rows: list[dict] = []
    counts: dict[str, int] = {label: 0 for label in SESSION_ORDER}
    for enr in enrollments:
        prog = program_by_id.get(enr["program_id"])
        if not prog:
            continue
        label = program_to_session_label(prog["name"])
        if label is None:
            continue
        c = contacts_by_id.get(enr["contact_id"])
        if not c:
            continue
        raw_format = (prog["format"] or "").lower()
        rows.append(
            {
                "session": label,
                "type": FORMAT_DISPLAY.get(raw_format, prog["format"] or ""),
                "first_name": (c.get("first_name") or "").strip(),
                "last_name": (c.get("last_name") or "").strip(),
                "email": (c.get("email") or "").strip(),
            }
        )
        counts[label] = counts.get(label, 0) + 1

    rows.sort(key=lambda r: (SESSION_RANK.get(r["session"], 999), r["last_name"].lower(), r["first_name"].lower()))
    return rows, counts


def build_attendees_values(rows: list[dict], updated_at: str) -> list[list[str]]:
    """First row carries the Last Updated stamp; remaining rows are attendees."""
    out: list[list[str]] = []
    for i, r in enumerate(rows):
        stamp = updated_at if i == 0 else ""
        out.append([r["session"], r["type"], r["first_name"], r["last_name"], r["email"], stamp])
    return out


def build_summary_updates(counts: dict[str, int], label_to_row: dict[str, int], updated_at: str) -> list[dict]:
    """Update Summary count column by matching column A label."""
    updates = []
    total = 0
    for label, row in label_to_row.items():
        if label == TOTAL_LABEL:
            continue
        if label not in counts:
            continue
        c = counts[label]
        total += c
        updates.append({"range": f"C{row}:D{row}", "values": [[str(c), updated_at]]})
    if TOTAL_LABEL in label_to_row:
        r = label_to_row[TOTAL_LABEL]
        updates.append({"range": f"C{r}:D{r}", "values": [[str(total), updated_at]]})
    return updates


def get_spreadsheet(sheet_id: str):
    creds_json = json.loads(os.environ["GOOGLE_SERVICE_ACCOUNT_JSON"])
    creds = Credentials.from_service_account_info(
        creds_json,
        scopes=["https://www.googleapis.com/auth/spreadsheets"],
    )
    gc = gspread.authorize(creds)
    return gc.open_by_key(sheet_id)


def ensure_attendees_tab(sh) -> "gspread.Worksheet":
    """Return the All Attendees tab, creating or renaming Sheet1 if needed."""
    try:
        return sh.worksheet(ATTENDEES_TAB)
    except gspread.WorksheetNotFound:
        pass
    # Try to rename a default Sheet1 if present.
    try:
        first = sh.sheet1
        if first.title == "Sheet1":
            first.update_title(ATTENDEES_TAB)
            first.resize(rows=500, cols=6)
            ws = first
        else:
            ws = sh.add_worksheet(ATTENDEES_TAB, rows=500, cols=6)
    except gspread.WorksheetNotFound:
        ws = sh.add_worksheet(ATTENDEES_TAB, rows=500, cols=6)
    ws.update(values=[["Session", "Type", "First Name", "Last Name", "Email", "Last Updated"]], range_name="A1:F1")
    ws.format("A1:F1", {"textFormat": {"bold": True}, "backgroundColor": {"red": 0.95, "green": 0.95, "blue": 0.95}})
    ws.freeze(rows=1)
    return ws


def ensure_summary_tab(sh) -> "gspread.Worksheet":
    """Create the Summary tab seeded with Karen's session order if it doesn't exist."""
    try:
        return sh.worksheet(SUMMARY_TAB)
    except gspread.WorksheetNotFound:
        ws = sh.add_worksheet(SUMMARY_TAB, rows=30, cols=5)
        ws.update(values=[["Session", "Type", "Count", "Last Updated"]], range_name="A1:D1")
        ws.format("A1:D1", {"textFormat": {"bold": True}})
        ws.freeze(rows=1)
        seed_rows = []
        for label in SESSION_ORDER:
            if "Online" in label:
                ftype = "Online"
            elif "In-Person" in label:
                ftype = "In-Person"
            else:
                ftype = "Online" if label == "Community Gatherings Only" else "In-Person"
            seed_rows.append([label, ftype])
        seed_rows.append([TOTAL_LABEL, ""])
        ws.update(values=seed_rows, range_name=f"A2:B{1 + len(seed_rows)}")
        ws.format(f"A{1 + len(seed_rows)}:D{1 + len(seed_rows)}", {"textFormat": {"bold": True}})
        return ws


def write_attendees(ws, rows: list[dict], updated_at: str) -> None:
    """Clear data rows then write the new roster."""
    last_col = "F"
    # Wipe everything below the header up to the current row count.
    end_row = max(ws.row_count, len(rows) + 1)
    ws.batch_clear([f"A2:{last_col}{end_row}"])
    if rows:
        values = build_attendees_values(rows, updated_at)
        ws.update(values=values, range_name=f"A2:{last_col}{1 + len(values)}")


def main() -> None:
    if not SHEET_ID:
        raise SystemExit("GOOGLE_SHEET_ID_ROSTER is not set")

    print("Connecting to Supabase...")
    sb = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_KEY"])

    print("Fetching roster...")
    rows, counts = fetch_roster(sb)
    updated_at = datetime.now(timezone.utc).strftime("%-d %b %Y %H:%M UTC")
    print(f"  {len(rows)} registered attendees across {sum(1 for c in counts.values() if c)} sessions")

    print("Opening live-roster sheet...")
    sh = get_spreadsheet(SHEET_ID)
    ws_attendees = ensure_attendees_tab(sh)
    ws_summary = ensure_summary_tab(sh)

    print(f"Writing {len(rows)} attendee row(s) to '{ATTENDEES_TAB}'...")
    write_attendees(ws_attendees, rows, updated_at)

    print(f"Updating '{SUMMARY_TAB}' counts...")
    summary_col_a = ws_summary.col_values(1)
    label_to_row = {label.strip(): i + 1 for i, label in enumerate(summary_col_a) if label.strip()}
    updates = build_summary_updates(counts, label_to_row, updated_at)
    if updates:
        ws_summary.batch_update(updates, value_input_option="USER_ENTERED")

    print(f"Live roster updated. ({updated_at})")


if __name__ == "__main__":
    main()
