import base64
import os
import time
import requests

CVENT_CLIENT_ID = os.environ.get("CVENT_CLIENT_ID", "0oa1c71wn3n5CRjCK1t8")
CVENT_CLIENT_SECRET = os.environ.get("CVENT_CLIENT_SECRET", "")
BASE_URL = "https://api-platform.cvent.com"


def get_token() -> str:
    creds = base64.b64encode(f"{CVENT_CLIENT_ID}:{CVENT_CLIENT_SECRET}".encode()).decode()
    r = requests.post(
        f"{BASE_URL}/ea/oauth2/token",
        headers={"Authorization": f"Basic {creds}", "Content-Type": "application/x-www-form-urlencoded"},
        data={"grant_type": "client_credentials"},
        timeout=15,
    )
    r.raise_for_status()
    return r.json()["access_token"]


def _get(token: str, path: str, params: dict | None = None, max_retries: int = 5) -> dict:
    # Cvent sporadically 429s the first request even when traffic has been quiet
    # (observed on the 2am UTC cron most nights). Retry on 429 and 5xx with
    # exponential backoff, honoring Retry-After when present.
    attempt = 0
    while True:
        r = requests.get(
            f"{BASE_URL}{path}",
            headers={"Authorization": f"Bearer {token}"},
            params=params or {},
            timeout=30,
        )
        if r.status_code < 400 or attempt >= max_retries or (r.status_code != 429 and r.status_code < 500):
            r.raise_for_status()
            return r.json()
        retry_after = r.headers.get("Retry-After")
        if retry_after and retry_after.isdigit():
            wait = min(int(retry_after), 60)
        else:
            wait = min(2 ** attempt, 30)
        print(f"  Cvent {r.status_code} on {path}; retrying in {wait}s (attempt {attempt + 1}/{max_retries})")
        time.sleep(wait)
        attempt += 1


def _paginate(token: str, path: str, base_params: dict) -> list:
    results = []
    next_tok = None
    while True:
        params = {**base_params, "limit": 100}
        if next_tok:
            params["token"] = next_tok
        d = _get(token, path, params)
        results.extend(d.get("data", []))
        next_tok = d.get("paging", {}).get("nextToken")
        if not next_tok:
            break
        time.sleep(2.0)
    return results


def fetch_sessions(token: str, event_id: str) -> list:
    """Return list of session dicts for an event."""
    return _paginate(token, "/ea/sessions", {"filter": f"event.id eq '{event_id}'"})


def fetch_attendees(token: str, event_id: str) -> dict:
    """Return dict of {attendee_id: {firstName, lastName, email, raw}} for an event."""
    rows = _paginate(token, "/ea/attendees", {"filter": f"event.id eq '{event_id}'"})
    return {
        att["id"]: {
            "firstName": att["contact"]["firstName"],
            "lastName": att["contact"]["lastName"],
            "email": att["contact"]["email"],
            "raw": att,
        }
        for att in rows
    }


def fetch_session_enrollments(token: str, session_id: str) -> list:
    """Return non-deleted enrollment dicts for a session."""
    rows = _paginate(token, "/ea/sessions/enrollment", {"filter": f"session.id eq '{session_id}'"})
    return [r for r in rows if not r.get("deleted")]
