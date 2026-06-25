import os
from pathlib import Path
from dotenv import load_dotenv
from supabase import create_client, Client


def get_supabase() -> Client:
    load_dotenv(Path(__file__).parent / ".env")
    return create_client(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_KEY"],
    )


def upsert_contact(sb: Client, client_id: str, email: str, first_name: str, last_name: str) -> str:
    result = sb.table("contacts").upsert(
        {"client_id": client_id, "email": email, "first_name": first_name, "last_name": last_name},
        on_conflict="email,client_id",
    ).execute()
    return result.data[0]["id"]


def upsert_program(
    sb: Client,
    client_id: str,
    name: str,
    year: int,
    program_format: str,
    platform: str,
    platform_id: str,
    tag: str,
    instructor: str | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
) -> str:
    result = sb.table("programs").upsert(
        {
            "client_id": client_id,
            "name": name,
            "year": year,
            "format": program_format,
            "platform": platform,
            "platform_id": platform_id,
            "tag": tag,
            "instructor": instructor,
            "start_date": start_date,
            "end_date": end_date,
        },
        on_conflict="client_id,platform,platform_id",
    ).execute()
    return result.data[0]["id"]


def upsert_enrollment(
    sb: Client,
    client_id: str,
    program_id: str,
    contact_id: str,
    status: str,
    enrolled_at: str | None,
    platform_enrollment_id: str,
    raw_data: dict,
) -> None:
    sb.table("enrollments").upsert(
        {
            "client_id": client_id,
            "program_id": program_id,
            "contact_id": contact_id,
            "status": status,
            "enrolled_at": enrolled_at,
            "platform_enrollment_id": platform_enrollment_id,
            "raw_data": raw_data,
        },
        on_conflict="contact_id,program_id",
    ).execute()


def apply_tag(sb: Client, contact_id: str, tag: str, client_id: str | None = None) -> None:
    result = sb.table("contacts").select("tags,client_id").eq("id", contact_id).single().execute()
    current_tags = result.data.get("tags") or []
    resolved_client_id = client_id or result.data.get("client_id")
    if tag not in current_tags:
        sb.table("contacts").update({"tags": current_tags + [tag]}).eq("id", contact_id).execute()
    # Ensure tag exists in the mail tool's tags catalog (count refreshed separately)
    if resolved_client_id:
        sb.table("tags").upsert(
            {"name": tag, "client_id": resolved_client_id, "contact_count": 0},
            on_conflict="name,client_id",
            ignore_duplicates=True,
        ).execute()


def refresh_tag_counts(sb: Client, client_id: str) -> None:
    """Recount all tag contacts for a client so the mail tool UI stays accurate."""
    tags = sb.table("tags").select("id,name").eq("client_id", client_id).execute().data
    for tag_row in tags:
        result = sb.table("contacts").select("id", count="exact").eq("client_id", client_id).contains("tags", [tag_row["name"]]).execute()
        sb.table("tags").update({"contact_count": result.count}).eq("id", tag_row["id"]).execute()


# --- Constant Contact mirror (Phase 1) -------------------------------------
# These write ONLY to the cc_* tables (a read-only reflection of Constant
# Contact). They never touch `contacts`, so CC data can never leak into the
# SendGrid send list. Identity resolution into the real people view is Phase 2.

def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def _epoch_to_iso(epoch: float | None) -> str | None:
    if not epoch:
        return None
    from datetime import datetime, timezone
    return datetime.fromtimestamp(float(epoch), tz=timezone.utc).isoformat()


def get_cc_state(sb: Client, client_id: str) -> dict | None:
    result = sb.table("cc_sync_state").select("*").eq("client_id", client_id).limit(1).execute()
    return result.data[0] if result.data else None


def save_cc_tokens(sb: Client, client_id: str, access_token: str, refresh_token: str, token_expires_at: float) -> None:
    """Persist a rotated token pair. token_expires_at is epoch seconds."""
    sb.table("cc_sync_state").update(
        {
            "access_token": access_token,
            "refresh_token": refresh_token,
            "token_expires_at": _epoch_to_iso(token_expires_at),
        }
    ).eq("client_id", client_id).execute()


def save_cc_run(sb: Client, client_id: str, updated_watermark: str | None, last_run_at: str, last_run_status: str) -> None:
    sb.table("cc_sync_state").update(
        {
            "updated_watermark": updated_watermark,
            "last_run_at": last_run_at,
            "last_run_status": last_run_status,
        }
    ).eq("client_id", client_id).execute()


def upsert_cc_list(sb: Client, client_id: str, lst: dict) -> None:
    sb.table("cc_lists").upsert(
        {
            "client_id": client_id,
            "cc_list_id": lst.get("list_id"),
            "name": lst.get("name"),
            "member_count": lst.get("membership_count"),
            "raw": lst,
            "synced_at": _now_iso(),
        },
        on_conflict="client_id,cc_list_id",
    ).execute()


def upsert_cc_contact(sb: Client, client_id: str, contact: dict) -> None:
    email = contact.get("email_address") or {}
    sb.table("cc_contacts").upsert(
        {
            "client_id": client_id,
            "cc_contact_id": contact.get("contact_id"),
            "email": email.get("address"),
            "first_name": contact.get("first_name"),
            "last_name": contact.get("last_name"),
            "permission": email.get("permission_to_send"),
            "opt_in_source": email.get("opt_in_source"),
            "opt_in_date": email.get("opt_in_date"),
            "opt_out_date": email.get("opt_out_date"),
            "created_at_cc": contact.get("created_at"),
            "updated_at_cc": contact.get("updated_at"),
            "custom_fields": contact.get("custom_fields"),
            "raw": contact,
            "synced_at": _now_iso(),
        },
        on_conflict="client_id,cc_contact_id",
    ).execute()


def replace_cc_memberships(sb: Client, client_id: str, cc_contact_id: str, list_ids: list[str]) -> None:
    """Delete-then-insert so a contact dropped from a list is reflected, not just adds."""
    sb.table("cc_list_memberships").delete().eq("client_id", client_id).eq("cc_contact_id", cc_contact_id).execute()
    if list_ids:
        sb.table("cc_list_memberships").insert(
            [{"client_id": client_id, "cc_contact_id": cc_contact_id, "cc_list_id": lid} for lid in list_ids]
        ).execute()
