import os
from pathlib import Path
from dotenv import load_dotenv
from supabase import create_client, Client

load_dotenv(Path(__file__).parent / ".env")


def get_supabase() -> Client:
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
    format: str,
    platform: str,
    platform_id: str,
    tag: str,
    instructor: str | None = None,
    start_date=None,
    end_date=None,
) -> str:
    result = sb.table("programs").upsert(
        {
            "client_id": client_id,
            "name": name,
            "year": year,
            "format": format,
            "platform": platform,
            "platform_id": platform_id,
            "tag": tag,
            "instructor": instructor,
            "start_date": str(start_date) if start_date else None,
            "end_date": str(end_date) if end_date else None,
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
    enrolled_at,
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


def apply_tag(sb: Client, contact_id: str, tag: str) -> None:
    result = sb.table("contacts").select("tags").eq("id", contact_id).single().execute()
    current_tags = result.data.get("tags") or []
    if tag not in current_tags:
        sb.table("contacts").update({"tags": current_tags + [tag]}).eq("id", contact_id).execute()
