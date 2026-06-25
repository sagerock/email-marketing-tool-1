import os
import time
import requests

API_BASE = "https://api.cc.email/v3"
TOKEN_URL = "https://authz.constantcontact.com/oauth2/default/v1/token"
CC_CLIENT_ID = os.environ.get("CC_CLIENT_ID", "")

# Refresh a little before the ~2h access token actually expires so a long
# pagination run never crosses the boundary mid-stream.
_EXPIRY_SKEW_SECONDS = 120


class CCClient:
    """Constant Contact v3 read client with durable token rotation.

    CC issues short-lived (~2h) access tokens and ROTATES the refresh token on
    every refresh, so the new pair must be persisted immediately or the next run
    locks out. `save_tokens` is injected (the entrypoint wires it to the DB) so
    this module stays storage-agnostic and easy to test.

    `save_tokens` is called as save_tokens(access_token=..., refresh_token=...,
    token_expires_at=<epoch seconds>).
    """

    def __init__(self, access_token, refresh_token, token_expires_at, save_tokens):
        self.access_token = access_token
        self.refresh_token = refresh_token
        self.token_expires_at = token_expires_at or 0.0  # epoch seconds
        self._save_tokens = save_tokens

    # --- auth -------------------------------------------------------------
    def _refresh(self):
        r = requests.post(
            TOKEN_URL,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            data={
                "grant_type": "refresh_token",
                "refresh_token": self.refresh_token,
                "client_id": CC_CLIENT_ID,
            },
            timeout=20,
        )
        r.raise_for_status()
        j = r.json()
        self.access_token = j["access_token"]
        # CC rotates the refresh token; keep the old one only if none came back.
        self.refresh_token = j.get("refresh_token", self.refresh_token)
        self.token_expires_at = time.time() + int(j.get("expires_in", 7200))
        # Persist the new pair BEFORE using it for anything else, so a rotated
        # refresh token is never lost to a crash mid-run.
        self._save_tokens(
            access_token=self.access_token,
            refresh_token=self.refresh_token,
            token_expires_at=self.token_expires_at,
        )

    def _ensure_token(self):
        if not self.access_token or time.time() >= self.token_expires_at - _EXPIRY_SKEW_SECONDS:
            self._refresh()

    def _get(self, path, params=None, _retried=False):
        self._ensure_token()
        url = f"{API_BASE}{path}" if path.startswith("/") else path
        r = requests.get(
            url,
            headers={"Authorization": f"Bearer {self.access_token}"},
            params=params or {},
            timeout=30,
        )
        if r.status_code == 401 and not _retried:
            # Token died early (revoked / clock skew). Refresh once and retry.
            self._refresh()
            return self._get(path, params, _retried=True)
        if r.status_code == 429:
            wait = r.headers.get("Retry-After", "5")
            time.sleep(min(int(wait) if wait.isdigit() else 5, 60))
            return self._get(path, params, _retried=_retried)
        r.raise_for_status()
        return r.json()

    # --- reads ------------------------------------------------------------
    def fetch_lists(self):
        """All contact lists with their membership counts."""
        d = self._get("/contact_lists", {"limit": 1000, "include_count": "true"})
        return d.get("lists", [])

    def iter_contacts(self, updated_after=None):
        """Yield CC contacts, following pagination.

        updated_after (ISO 8601) restricts to contacts changed since then; pass
        None for a full backfill. CC carries the next page as a fully-formed
        href under _links.next, so after the first request the cursor href
        already holds the query params.
        """
        params = {"include": "list_memberships,custom_fields", "limit": 500}
        if updated_after:
            params["updated_after"] = updated_after

        path = "/contacts"
        first = True
        while path:
            d = self._get(path, params if first else None)
            first = False
            for c in d.get("contacts", []):
                yield c
            nxt = (d.get("_links") or {}).get("next", {}).get("href")
            # next href comes back like "/v3/contacts?cursor=..."; strip the /v3
            # so it lands on API_BASE (which already ends in /v3).
            path = nxt[3:] if nxt and nxt.startswith("/v3") else nxt
