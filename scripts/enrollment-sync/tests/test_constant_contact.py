from unittest.mock import patch, MagicMock
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from connectors import constant_contact as cc


def _resp(payload, status=200):
    m = MagicMock()
    m.status_code = status
    m.json.return_value = payload
    m.headers = {}
    m.raise_for_status.return_value = None
    return m


def _client(saved):
    # Token valid far into the future so _ensure_token never refreshes unless asked.
    return cc.CCClient(
        access_token="tok",
        refresh_token="refresh-1",
        token_expires_at=9_999_999_999,
        save_tokens=lambda **kw: saved.append(kw),
    )


@patch("connectors.constant_contact.requests.get")
def test_iter_contacts_paginates_via_links_next(mock_get):
    mock_get.side_effect = [
        _resp({"contacts": [{"contact_id": "a"}], "_links": {"next": {"href": "/v3/contacts?cursor=2"}}}),
        _resp({"contacts": [{"contact_id": "b"}]}),
    ]
    client = _client([])
    ids = [c["contact_id"] for c in client.iter_contacts()]
    assert ids == ["a", "b"]
    # Second request must hit the stripped cursor URL on API_BASE.
    second_url = mock_get.call_args_list[1].args[0]
    assert second_url == f"{cc.API_BASE}/contacts?cursor=2"


@patch("connectors.constant_contact.requests.get")
def test_iter_contacts_passes_updated_after(mock_get):
    mock_get.return_value = _resp({"contacts": []})
    list(_client([]).iter_contacts(updated_after="2026-06-01T00:00:00Z"))
    params = mock_get.call_args.kwargs["params"]
    assert params["updated_after"] == "2026-06-01T00:00:00Z"


@patch("connectors.constant_contact.requests.post")
@patch("connectors.constant_contact.requests.get")
def test_401_triggers_refresh_and_persists_rotated_token(mock_get, mock_post):
    saved = []
    mock_get.side_effect = [
        _resp({}, status=401),
        _resp({"lists": [{"list_id": "L1", "name": "All"}]}),
    ]
    mock_post.return_value = _resp({"access_token": "tok2", "refresh_token": "refresh-2", "expires_in": 7200})

    client = _client(saved)
    lists = client.fetch_lists()

    assert lists[0]["list_id"] == "L1"
    assert client.access_token == "tok2"
    # Rotated refresh token was persisted (the lock-out guard).
    assert saved and saved[-1]["refresh_token"] == "refresh-2"


@patch("connectors.constant_contact.requests.post")
@patch("connectors.constant_contact.requests.get")
def test_expired_token_refreshes_before_first_call(mock_get, mock_post):
    saved = []
    mock_post.return_value = _resp({"access_token": "fresh", "refresh_token": "refresh-2", "expires_in": 7200})
    mock_get.return_value = _resp({"lists": []})

    client = cc.CCClient("old", "refresh-1", token_expires_at=0, save_tokens=lambda **kw: saved.append(kw))
    client.fetch_lists()

    mock_post.assert_called_once()
    assert client.access_token == "fresh"
