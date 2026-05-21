from unittest.mock import patch, MagicMock
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from connectors import cvent


def _mock_response(data, next_token=None):
    m = MagicMock()
    m.json.return_value = {
        "data": data,
        "paging": {"nextToken": next_token},
    }
    m.raise_for_status.return_value = None
    return m


@patch("connectors.cvent.requests.get")
def test_fetch_session_enrollments_returns_non_deleted(mock_get):
    mock_get.return_value = _mock_response([
        {"id": "enr-1", "attendee": {"id": "att-1"}, "status": "Registered", "deleted": False},
        {"id": "enr-2", "attendee": {"id": "att-2"}, "status": "Registered", "deleted": True},
    ])
    result = cvent.fetch_session_enrollments("fake-token", "session-123")
    assert len(result) == 1
    assert result[0]["id"] == "enr-1"


@patch("connectors.cvent.time.sleep")
@patch("connectors.cvent.requests.get")
def test_fetch_session_enrollments_paginates(mock_get, mock_sleep):
    mock_get.side_effect = [
        _mock_response([{"id": "enr-1", "attendee": {"id": "att-1"}, "status": "Registered"}], next_token="page2"),
        _mock_response([{"id": "enr-2", "attendee": {"id": "att-2"}, "status": "Registered"}], next_token=None),
    ]
    result = cvent.fetch_session_enrollments("fake-token", "session-123")
    assert len(result) == 2
    mock_sleep.assert_called_once_with(0.6)


@patch("connectors.cvent.requests.get")
def test_fetch_attendees_builds_lookup_dict(mock_get):
    mock_get.return_value = _mock_response([
        {
            "id": "att-1",
            "contact": {"firstName": "Jane", "lastName": "Doe", "email": "jane@example.com"},
        }
    ])
    result = cvent.fetch_attendees("fake-token", "event-123")
    assert "att-1" in result
    assert result["att-1"]["email"] == "jane@example.com"
    assert result["att-1"]["raw"]["id"] == "att-1"


@patch("connectors.cvent.requests.get")
def test_fetch_sessions_returns_list(mock_get):
    mock_get.return_value = _mock_response([
        {"id": "session-1", "name": "Grade 1 Teaching"},
        {"id": "session-2", "name": "Grade 2 Teaching"},
    ])
    result = cvent.fetch_sessions("fake-token", "event-123")
    assert len(result) == 2
    assert result[0]["id"] == "session-1"
