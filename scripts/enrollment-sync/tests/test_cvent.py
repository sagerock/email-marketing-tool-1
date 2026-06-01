from unittest.mock import patch, MagicMock
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from connectors import cvent


def _mock_response(data, next_token=None):
    m = MagicMock()
    m.status_code = 200
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
    mock_sleep.assert_called_once_with(2.0)


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


def _mock_error_response(status_code, headers=None):
    m = MagicMock()
    m.status_code = status_code
    m.headers = headers or {}
    m.raise_for_status.side_effect = __import__("requests").exceptions.HTTPError(f"{status_code} error")
    return m


@patch("connectors.cvent.time.sleep")
@patch("connectors.cvent.requests.get")
def test_get_retries_on_429_then_succeeds(mock_get, mock_sleep):
    mock_get.side_effect = [
        _mock_error_response(429, headers={"Retry-After": "3"}),
        _mock_error_response(429),
        _mock_response([{"id": "ok"}]),
    ]
    result = cvent._get("fake-token", "/ea/attendees")
    assert result["data"][0]["id"] == "ok"
    assert mock_get.call_count == 3
    # First wait honors Retry-After header (3s), second uses exponential backoff (2^1 = 2)
    assert mock_sleep.call_args_list[0].args == (3,)
    assert mock_sleep.call_args_list[1].args == (2,)


@patch("connectors.cvent.time.sleep")
@patch("connectors.cvent.requests.get")
def test_get_retries_on_5xx(mock_get, mock_sleep):
    mock_get.side_effect = [
        _mock_error_response(503),
        _mock_response([{"id": "ok"}]),
    ]
    result = cvent._get("fake-token", "/ea/sessions")
    assert result["data"][0]["id"] == "ok"
    assert mock_get.call_count == 2


@patch("connectors.cvent.time.sleep")
@patch("connectors.cvent.requests.get")
def test_get_does_not_retry_on_4xx_other_than_429(mock_get, mock_sleep):
    import requests as _requests
    mock_get.return_value = _mock_error_response(404)
    try:
        cvent._get("fake-token", "/ea/missing")
        assert False, "expected HTTPError"
    except _requests.exceptions.HTTPError:
        pass
    assert mock_get.call_count == 1
    mock_sleep.assert_not_called()


@patch("connectors.cvent.time.sleep")
@patch("connectors.cvent.requests.get")
def test_get_gives_up_after_max_retries(mock_get, mock_sleep):
    import requests as _requests
    mock_get.return_value = _mock_error_response(429)
    try:
        cvent._get("fake-token", "/ea/attendees", max_retries=2)
        assert False, "expected HTTPError"
    except _requests.exceptions.HTTPError:
        pass
    assert mock_get.call_count == 3  # initial + 2 retries
    assert mock_sleep.call_count == 2
