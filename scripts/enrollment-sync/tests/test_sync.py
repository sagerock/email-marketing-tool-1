from unittest.mock import MagicMock, patch, call
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import sync


MOCK_CONFIG = {
    "client_id": "client-uuid-1",
    "cvent_event_id": "event-uuid-1",
    "sessions": {
        "session-uuid-1": {
            "name": "Grade 1 Teaching - Renewal 2026 Online",
            "year": 2026,
            "format": "online",
            "instructor": "Lori Kran",
            "tag": "grade-1-renewal-2026-online",
        }
    },
}

MOCK_ATTENDEES = {
    "att-1": {"firstName": "Jane", "lastName": "Doe", "email": "jane@example.com", "raw": {}},
}

MOCK_ENROLLMENTS = [
    {"id": "enr-1", "attendee": {"id": "att-1"}, "status": "Registered", "registrationDate": "2026-01-15T00:00:00Z"},
]


@patch("sync.cvent.fetch_session_enrollments", return_value=MOCK_ENROLLMENTS)
@patch("sync.cvent.fetch_attendees", return_value=MOCK_ATTENDEES)
@patch("sync.cvent.get_token", return_value="fake-token")
def test_dry_run_makes_no_db_calls(mock_token, mock_attendees, mock_enrollments):
    sb = MagicMock()
    sync.sync_cvent_session(sb, MOCK_CONFIG, "session-uuid-1", dry_run=True)
    sb.table.assert_not_called()


@patch("sync.cvent.fetch_session_enrollments", return_value=MOCK_ENROLLMENTS)
@patch("sync.cvent.fetch_attendees", return_value=MOCK_ATTENDEES)
@patch("sync.cvent.get_token", return_value="fake-token")
@patch("sync.db.apply_tag")
@patch("sync.db.upsert_enrollment")
@patch("sync.db.upsert_contact", return_value="contact-uuid-1")
@patch("sync.db.upsert_program", return_value="program-uuid-1")
def test_sync_upserts_contact_program_enrollment_and_tag(
    mock_program, mock_contact, mock_enrollment, mock_tag,
    mock_token, mock_attendees, mock_enrollments,
):
    sb = MagicMock()
    sync.sync_cvent_session(sb, MOCK_CONFIG, "session-uuid-1", dry_run=False)
    mock_program.assert_called_once()
    mock_contact.assert_called_once_with(sb, "client-uuid-1", "jane@example.com", "Jane", "Doe")
    mock_enrollment.assert_called_once()
    mock_tag.assert_called_once_with(sb, "contact-uuid-1", "grade-1-renewal-2026-online")


@patch("sync.cvent.fetch_session_enrollments", return_value=[
    {"id": "enr-1", "attendee": {"id": "att-1"}, "status": "Cancelled", "registrationDate": "2026-01-15T00:00:00Z"},
])
@patch("sync.cvent.fetch_attendees", return_value=MOCK_ATTENDEES)
@patch("sync.cvent.get_token", return_value="fake-token")
@patch("sync.db.apply_tag")
@patch("sync.db.upsert_enrollment")
@patch("sync.db.upsert_contact", return_value="contact-uuid-1")
@patch("sync.db.upsert_program", return_value="program-uuid-1")
def test_cancelled_enrollment_does_not_apply_tag(
    mock_program, mock_contact, mock_enrollment, mock_tag,
    mock_token, mock_attendees, mock_enrollments,
):
    sb = MagicMock()
    sync.sync_cvent_session(sb, MOCK_CONFIG, "session-uuid-1", dry_run=False)
    mock_tag.assert_not_called()
