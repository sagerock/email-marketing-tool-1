from unittest.mock import MagicMock
import pytest
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import db


def make_sb(return_id="contact-uuid-1"):
    """Build a mock Supabase client that chains table().upsert().execute() etc."""
    sb = MagicMock()
    sb.table.return_value.upsert.return_value.execute.return_value.data = [{"id": return_id}]
    sb.table.return_value.update.return_value.eq.return_value.execute.return_value = None
    sb.table.return_value.select.return_value.eq.return_value.single.return_value.execute.return_value.data = {
        "tags": []
    }
    return sb


def test_upsert_contact_returns_id():
    sb = make_sb()
    contact_id = db.upsert_contact(sb, "client-1", "jane@example.com", "Jane", "Doe")
    assert contact_id == "contact-uuid-1"


def test_upsert_contact_passes_correct_fields():
    sb = make_sb()
    db.upsert_contact(sb, "client-1", "jane@example.com", "Jane", "Doe")
    upsert_call = sb.table.return_value.upsert.call_args
    data = upsert_call[0][0]
    assert data["client_id"] == "client-1"
    assert data["email"] == "jane@example.com"
    assert data["first_name"] == "Jane"
    assert data["last_name"] == "Doe"


def test_upsert_program_returns_id():
    sb = make_sb(return_id="program-uuid-1")
    program_id = db.upsert_program(
        sb, "client-1", "Grade 4 Renewal 2026", 2026, "online",
        "cvent", "session-id-1", "grade-4-renewal-2026-online",
    )
    assert program_id == "program-uuid-1"


def test_upsert_program_passes_correct_fields():
    sb = make_sb(return_id="program-uuid-1")
    db.upsert_program(
        sb, "client-1", "Grade 4 Renewal 2026", 2026, "online",
        "cvent", "session-id-1", "grade-4-renewal-2026-online",
        instructor="Jane Smith", start_date="2026-09-01", end_date="2027-06-30",
    )
    upsert_call = sb.table.return_value.upsert.call_args
    data = upsert_call[0][0]
    assert data["client_id"] == "client-1"
    assert data["name"] == "Grade 4 Renewal 2026"
    assert data["year"] == 2026
    assert data["format"] == "online"
    assert data["platform"] == "cvent"
    assert data["platform_id"] == "session-id-1"
    assert data["tag"] == "grade-4-renewal-2026-online"
    assert data["instructor"] == "Jane Smith"
    assert data["start_date"] == "2026-09-01"
    assert data["end_date"] == "2027-06-30"


def test_upsert_enrollment_passes_correct_fields():
    sb = make_sb()
    db.upsert_enrollment(
        sb,
        client_id="client-1",
        program_id="program-uuid-1",
        contact_id="contact-uuid-1",
        status="enrolled",
        enrolled_at="2026-08-15T10:00:00Z",
        platform_enrollment_id="cvent-reg-999",
        raw_data={"source": "cvent"},
    )
    upsert_call = sb.table.return_value.upsert.call_args
    data = upsert_call[0][0]
    assert data["client_id"] == "client-1"
    assert data["program_id"] == "program-uuid-1"
    assert data["contact_id"] == "contact-uuid-1"
    assert data["status"] == "enrolled"
    assert data["enrolled_at"] == "2026-08-15T10:00:00Z"
    assert data["platform_enrollment_id"] == "cvent-reg-999"
    assert data["raw_data"] == {"source": "cvent"}


def test_apply_tag_adds_tag_when_not_present():
    sb = MagicMock()
    sb.table.return_value.select.return_value.eq.return_value.single.return_value.execute.return_value.data = {
        "tags": ["existing-tag"]
    }
    db.apply_tag(sb, "contact-uuid-1", "new-tag")
    update_call = sb.table.return_value.update.call_args
    assert "new-tag" in update_call[0][0]["tags"]
    assert "existing-tag" in update_call[0][0]["tags"]


def test_apply_tag_skips_when_already_present():
    sb = MagicMock()
    sb.table.return_value.select.return_value.eq.return_value.single.return_value.execute.return_value.data = {
        "tags": ["grade-4-renewal-2026-online"]
    }
    db.apply_tag(sb, "contact-uuid-1", "grade-4-renewal-2026-online")
    sb.table.return_value.update.assert_not_called()


def test_apply_tag_handles_null_tags():
    sb = MagicMock()
    sb.table.return_value.select.return_value.eq.return_value.single.return_value.execute.return_value.data = {
        "tags": None
    }
    db.apply_tag(sb, "contact-uuid-1", "new-tag")
    update_call = sb.table.return_value.update.call_args
    assert update_call[0][0]["tags"] == ["new-tag"]
