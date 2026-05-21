# Enrollment Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a connector-based enrollment sync script that pulls course rosters from Cvent (Phase 1) into the mail tool's Supabase database as structured `programs` + `enrollments` records, auto-tagging contacts for campaign targeting.

**Architecture:** Two new Supabase tables (`programs`, `enrollments`) store structured enrollment history. A Python CLI script (`sync.py`) with a pluggable connector pattern fetches rosters from external platforms and upserts into Supabase, applying contact tags that the existing mail tool campaign system already understands. No changes to the mail tool frontend or API.

**Tech Stack:** Python 3.12, supabase-py 2.x, requests, python-dotenv, pytest. Supabase project `ckloewflialohuvixmvd`.

**Spec:** `docs/superpowers/specs/2026-05-21-enrollment-sync-design.md`

---

## File Map

| Action | Path |
|--------|------|
| Create | `supabase/migrations/050_create_programs.sql` |
| Create | `supabase/migrations/051_create_enrollments.sql` |
| Create | `scripts/enrollment-sync/requirements.txt` |
| Create | `scripts/enrollment-sync/.env.example` |
| Create | `scripts/enrollment-sync/connectors/__init__.py` |
| Create | `scripts/enrollment-sync/db.py` |
| Create | `scripts/enrollment-sync/tests/__init__.py` |
| Create | `scripts/enrollment-sync/tests/test_db.py` |
| Create | `scripts/enrollment-sync/connectors/cvent.py` |
| Create | `scripts/enrollment-sync/tests/test_cvent.py` |
| Create | `scripts/enrollment-sync/config/cfa.json` |
| Create | `scripts/enrollment-sync/sync.py` |
| Create | `scripts/enrollment-sync/tests/test_sync.py` |

---

## Task 1: Create CfA Client Record in Mail Tool

CfA does not yet exist as a client in the mail tool's Supabase. Create the record so contacts and programs can be scoped to CfA.

**Files:** (no files — SQL only)

- [ ] **Step 1: Insert the CfA client record**

  Run this SQL in the Supabase dashboard (project `ckloewflialohuvixmvd`) or via the MCP:

  ```sql
  INSERT INTO clients (name, sendgrid_api_key)
  VALUES ('Center for Anthroposophy', '<value-from-cfa-.env-SENDGRID_API_KEY>')
  RETURNING id, name;
  ```

  The `SENDGRID_API_KEY` value is in `/home/sage/scripts/sagerock/clients/center-for-anthroposophy/.env`.

- [ ] **Step 2: Record the returned UUID**

  Copy the `id` from the result. You will need it in Task 6 (config/cfa.json).

- [ ] **Step 3: Commit**

  Nothing to commit — this is a database operation only. Note the UUID somewhere handy.

---

## Task 2: Schema Migrations

Create `programs` and `enrollments` tables with appropriate indexes and RLS policies.

**Files:**
- Create: `supabase/migrations/050_create_programs.sql`
- Create: `supabase/migrations/051_create_enrollments.sql`

- [ ] **Step 1: Write the programs migration**

  Create `supabase/migrations/050_create_programs.sql`:

  ```sql
  create table programs (
    id uuid primary key default gen_random_uuid(),
    client_id uuid not null references clients(id) on delete cascade,
    name text not null,
    year int not null,
    format text not null check (format in ('online', 'in-person', 'hybrid')),
    platform text not null check (platform in ('cvent', 'gravity_forms', 'thinkific', 'manual')),
    platform_id text not null,
    tag text not null,
    instructor text,
    start_date date,
    end_date date,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (client_id, platform_id)
  );

  create index programs_client_id_idx on programs(client_id);
  create index programs_year_idx on programs(year);

  create or replace function update_programs_updated_at()
  returns trigger language plpgsql as $$
  begin
    new.updated_at = now();
    return new;
  end;
  $$;

  create trigger programs_updated_at
    before update on programs
    for each row execute function update_programs_updated_at();

  alter table programs enable row level security;

  create policy "client_isolation" on programs
    using (client_id = (
      select client_id from admin_users where user_id = auth.uid()
    ));
  ```

- [ ] **Step 2: Write the enrollments migration**

  Create `supabase/migrations/051_create_enrollments.sql`:

  ```sql
  create table enrollments (
    id uuid primary key default gen_random_uuid(),
    client_id uuid not null references clients(id) on delete cascade,
    program_id uuid not null references programs(id) on delete cascade,
    contact_id uuid not null references contacts(id) on delete cascade,
    status text not null check (status in ('registered', 'cancelled', 'waitlisted')),
    enrolled_at timestamptz,
    platform_enrollment_id text,
    raw_data jsonb not null default '{}',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (contact_id, program_id)
  );

  create index enrollments_contact_id_idx on enrollments(contact_id);
  create index enrollments_program_id_idx on enrollments(program_id);
  create index enrollments_client_id_idx on enrollments(client_id);
  create index enrollments_status_idx on enrollments(status);

  create or replace function update_enrollments_updated_at()
  returns trigger language plpgsql as $$
  begin
    new.updated_at = now();
    return new;
  end;
  $$;

  create trigger enrollments_updated_at
    before update on enrollments
    for each row execute function update_enrollments_updated_at();

  alter table enrollments enable row level security;

  create policy "client_isolation" on enrollments
    using (client_id = (
      select client_id from admin_users where user_id = auth.uid()
    ));
  ```

- [ ] **Step 3: Apply migrations via Supabase MCP**

  Use `mcp__supabase__apply_migration` with project_id `ckloewflialohuvixmvd` for each file in order: 050 first, then 051.

- [ ] **Step 4: Verify tables exist**

  ```sql
  select table_name from information_schema.tables
  where table_schema = 'public'
  and table_name in ('programs', 'enrollments');
  ```

  Expected: two rows returned.

- [ ] **Step 5: Commit**

  ```bash
  git add supabase/migrations/050_create_programs.sql supabase/migrations/051_create_enrollments.sql
  git commit -m "feat(db): add programs and enrollments tables"
  ```

---

## Task 3: Project Setup

Create the directory structure, dependencies, and empty connector package.

**Files:**
- Create: `scripts/enrollment-sync/requirements.txt`
- Create: `scripts/enrollment-sync/.env.example`
- Create: `scripts/enrollment-sync/connectors/__init__.py`
- Create: `scripts/enrollment-sync/tests/__init__.py`

- [ ] **Step 1: Create requirements.txt**

  ```
  supabase>=2.0.0
  requests>=2.31.0
  python-dotenv>=1.0.0
  pytest>=8.0.0
  ```

- [ ] **Step 2: Create .env.example**

  ```
  SUPABASE_URL=https://ckloewflialohuvixmvd.supabase.co
  SUPABASE_SERVICE_KEY=<service-role-key-from-supabase-dashboard>
  CVENT_CLIENT_ID=0oa1c71wn3n5CRjCK1t8
  CVENT_CLIENT_SECRET=<from-cvent-admin>
  ```

- [ ] **Step 3: Create .env from .env.example**

  ```bash
  cp scripts/enrollment-sync/.env.example scripts/enrollment-sync/.env
  ```

  Fill in `SUPABASE_SERVICE_KEY` from the Supabase dashboard (Project Settings → API → service_role key). Fill in `CVENT_CLIENT_SECRET` from the CfA Cvent admin.

  The `.env` is already covered by the root `.gitignore`.

- [ ] **Step 4: Create empty package files**

  `scripts/enrollment-sync/connectors/__init__.py` — empty file.

  `scripts/enrollment-sync/tests/__init__.py` — empty file.

- [ ] **Step 5: Install dependencies**

  ```bash
  cd scripts/enrollment-sync && pip install -r requirements.txt
  ```

  Expected: all packages install without error.

- [ ] **Step 6: Commit**

  ```bash
  git add scripts/enrollment-sync/requirements.txt scripts/enrollment-sync/.env.example \
          scripts/enrollment-sync/connectors/__init__.py scripts/enrollment-sync/tests/__init__.py
  git commit -m "feat(enrollment-sync): scaffold project structure"
  ```

---

## Task 4: db.py — Supabase Upsert Operations

Write the database layer that all connectors share: upsert contacts, programs, enrollments, and apply tags.

**Files:**
- Create: `scripts/enrollment-sync/db.py`
- Create: `scripts/enrollment-sync/tests/test_db.py`

- [ ] **Step 1: Write failing tests**

  Create `scripts/enrollment-sync/tests/test_db.py`:

  ```python
  from unittest.mock import MagicMock, patch, call
  import pytest
  import sys
  import os

  sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

  import db


  def make_sb():
      """Build a mock Supabase client that chains table().upsert().execute() etc."""
      sb = MagicMock()
      chain = MagicMock()
      chain.execute.return_value.data = [{"id": "contact-uuid-1"}]
      sb.table.return_value.upsert.return_value = chain
      sb.table.return_value.update.return_value.eq.return_value.execute.return_value = None
      sb.table.return_value.select.return_value.eq.return_value.single.return_value.execute.return_value.data = {
          "tags": []
      }
      return sb


  def test_upsert_contact_returns_id():
      sb = make_sb()
      contact_id = db.upsert_contact(sb, "client-1", "jane@example.com", "Jane", "Doe")
      assert contact_id == "contact-uuid-1"
      sb.table.assert_called_with("contacts")


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
      sb = make_sb()
      sb.table.return_value.upsert.return_value.execute.return_value.data = [{"id": "program-uuid-1"}]
      program_id = db.upsert_program(
          sb, "client-1", "Grade 4 Renewal 2026", 2026, "online",
          "cvent", "session-id-1", "grade-4-renewal-2026-online",
      )
      assert program_id == "program-uuid-1"


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
  ```

- [ ] **Step 2: Run tests to confirm they fail**

  ```bash
  cd scripts/enrollment-sync && python -m pytest tests/test_db.py -v
  ```

  Expected: `ModuleNotFoundError: No module named 'db'`

- [ ] **Step 3: Implement db.py**

  Create `scripts/enrollment-sync/db.py`:

  ```python
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
          on_conflict="client_id,platform_id",
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
  ```

- [ ] **Step 4: Run tests to confirm they pass**

  ```bash
  cd scripts/enrollment-sync && python -m pytest tests/test_db.py -v
  ```

  Expected: 5 tests pass.

- [ ] **Step 5: Commit**

  ```bash
  git add scripts/enrollment-sync/db.py scripts/enrollment-sync/tests/test_db.py
  git commit -m "feat(enrollment-sync): add Supabase upsert layer"
  ```

---

## Task 5: Cvent Connector

Pull the Cvent API logic from `send_renewal_welcome_letters.py` into a reusable connector module.

**Files:**
- Create: `scripts/enrollment-sync/connectors/cvent.py`
- Create: `scripts/enrollment-sync/tests/test_cvent.py`

- [ ] **Step 1: Write failing tests**

  Create `scripts/enrollment-sync/tests/test_cvent.py`:

  ```python
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
      token = "fake-token"
      result = cvent.fetch_session_enrollments(token, "session-123")
      assert len(result) == 1
      assert result[0]["id"] == "enr-1"


  @patch("connectors.cvent.requests.get")
  def test_fetch_session_enrollments_paginates(mock_get):
      mock_get.side_effect = [
          _mock_response([{"id": "enr-1", "attendee": {"id": "att-1"}, "status": "Registered"}], next_token="page2"),
          _mock_response([{"id": "enr-2", "attendee": {"id": "att-2"}, "status": "Registered"}], next_token=None),
      ]
      result = cvent.fetch_session_enrollments("fake-token", "session-123")
      assert len(result) == 2


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
  ```

- [ ] **Step 2: Run tests to confirm they fail**

  ```bash
  cd scripts/enrollment-sync && python -m pytest tests/test_cvent.py -v
  ```

  Expected: `ModuleNotFoundError: No module named 'connectors.cvent'`

- [ ] **Step 3: Implement connectors/cvent.py**

  Create `scripts/enrollment-sync/connectors/cvent.py`:

  ```python
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


  def _get(token: str, path: str, params: dict | None = None) -> dict:
      r = requests.get(
          f"{BASE_URL}{path}",
          headers={"Authorization": f"Bearer {token}"},
          params=params or {},
          timeout=30,
      )
      r.raise_for_status()
      return r.json()


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
          time.sleep(0.6)
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
  ```

- [ ] **Step 4: Run tests to confirm they pass**

  ```bash
  cd scripts/enrollment-sync && python -m pytest tests/test_cvent.py -v
  ```

  Expected: 4 tests pass.

- [ ] **Step 5: Commit**

  ```bash
  git add scripts/enrollment-sync/connectors/cvent.py scripts/enrollment-sync/tests/test_cvent.py
  git commit -m "feat(enrollment-sync): add Cvent connector"
  ```

---

## Task 6: CfA Client Config

Declare the CfA client ID and all 2026 Renewal session configs in a JSON file. This is the only file that changes when sessions are added or years roll over.

**Files:**
- Create: `scripts/enrollment-sync/config/cfa.json`

- [ ] **Step 1: Populate the config with online sessions**

  Replace `<cfa-client-uuid>` with the UUID from Task 1 Step 2.

  Create `scripts/enrollment-sync/config/cfa.json`:

  ```json
  {
    "client_id": "<cfa-client-uuid>",
    "cvent_event_id": "b90c7d57-6012-485f-b9c5-11add0ff0f03",
    "sessions": {
      "49b6e8b1-d7b8-44c9-b82d-f2bed03e418a": {
        "name": "Grade 1 Teaching - Renewal 2026 Online",
        "year": 2026,
        "format": "online",
        "instructor": "Lori Kran",
        "tag": "grade-1-renewal-2026-online"
      },
      "84547587-9c7f-45eb-b62d-89b5fd2d011b": {
        "name": "Grade 2 Teaching - Renewal 2026 Online",
        "year": 2026,
        "format": "online",
        "instructor": "Jennifer Persinotti",
        "tag": "grade-2-renewal-2026-online"
      },
      "f76f8da7-1ef8-4701-8c54-580656063737": {
        "name": "Grade 3 Teaching - Renewal 2026 Online",
        "year": 2026,
        "format": "online",
        "instructor": "Kris Ritz",
        "tag": "grade-3-renewal-2026-online"
      },
      "dd9a1753-5a72-433c-8ea9-768c6e05d7d2": {
        "name": "Grade 4 Teaching - Renewal 2026 Online",
        "year": 2026,
        "format": "online",
        "instructor": "Irene Richardson",
        "tag": "grade-4-renewal-2026-online"
      },
      "5d2b8016-3809-4608-a9f9-460919198a38": {
        "name": "Grade 5 Teaching - Renewal 2026 Online",
        "year": 2026,
        "format": "online",
        "instructor": "Jen Kershaw",
        "tag": "grade-5-renewal-2026-online"
      },
      "21f21e7e-dbed-46c9-84bd-87bf7f857736": {
        "name": "Grade 6 Teaching - Renewal 2026 Online",
        "year": 2026,
        "format": "online",
        "instructor": "Sarah Nelson",
        "tag": "grade-6-renewal-2026-online"
      },
      "5c389c5f-fe1d-4555-88bd-40d18b9c04e7": {
        "name": "Grade 7 Teaching - Renewal 2026 Online",
        "year": 2026,
        "format": "online",
        "instructor": "Sarah Azzinaro",
        "tag": "grade-7-renewal-2026-online"
      },
      "df5b26b7-eacf-4b57-bea6-97cb7ebd8cd8": {
        "name": "Grade 8 Teaching - Renewal 2026 Online",
        "year": 2026,
        "format": "online",
        "instructor": "Sonya Schewe",
        "tag": "grade-8-renewal-2026-online"
      }
    }
  }
  ```

- [ ] **Step 2: Find and add in-person session IDs**

  The in-person session IDs are not yet known. Run this to list all sessions for the Renewal 2026 event and find the in-person ones:

  ```bash
  cd scripts/enrollment-sync
  python3 -c "
  from dotenv import load_dotenv; load_dotenv('.env')
  from connectors import cvent
  token = cvent.get_token()
  sessions = cvent.fetch_sessions(token, 'b90c7d57-6012-485f-b9c5-11add0ff0f03')
  for s in sessions:
      print(s.get('id'), s.get('name'))
  "
  ```

  For each in-person grade session returned, add an entry to `config/cfa.json` following the same pattern with `"format": "in-person"` and the correct instructor (Grade 1 in-person = Sarah Galligan, Grade 6 in-person = Julia Pellegrino, all others same as online).

- [ ] **Step 3: Commit**

  ```bash
  git add scripts/enrollment-sync/config/cfa.json
  git commit -m "feat(enrollment-sync): add CfA session config for Renewal 2026"
  ```

---

## Task 7: sync.py — CLI Entry Point

Wire connectors and db together into a runnable command.

**Files:**
- Create: `scripts/enrollment-sync/sync.py`
- Create: `scripts/enrollment-sync/tests/test_sync.py`

- [ ] **Step 1: Write failing tests**

  Create `scripts/enrollment-sync/tests/test_sync.py`:

  ```python
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
  ```

- [ ] **Step 2: Run tests to confirm they fail**

  ```bash
  cd scripts/enrollment-sync && python -m pytest tests/test_sync.py -v
  ```

  Expected: `ModuleNotFoundError: No module named 'sync'`

- [ ] **Step 3: Implement sync.py**

  Create `scripts/enrollment-sync/sync.py`:

  ```python
  import argparse
  import json
  import os
  from pathlib import Path
  from dotenv import load_dotenv

  load_dotenv(Path(__file__).parent / ".env")

  import db
  from connectors import cvent

  CONFIG_DIR = Path(__file__).parent / "config"

  STATUS_MAP = {
      "Registered": "registered",
      "Cancelled": "cancelled",
      "Waitlisted": "waitlisted",
  }


  def load_config(client_name: str) -> dict:
      path = CONFIG_DIR / f"{client_name}.json"
      if not path.exists():
          raise FileNotFoundError(f"No config found for client '{client_name}' at {path}")
      with open(path) as f:
          return json.load(f)


  def sync_cvent_session(sb, config: dict, session_id: str, dry_run: bool = False) -> None:
      session_config = config["sessions"][session_id]
      event_id = config["cvent_event_id"]
      client_id = config["client_id"]

      print(f"  Authenticating with Cvent...")
      token = cvent.get_token()

      print(f"  Fetching attendees for event {event_id}...")
      all_attendees = cvent.fetch_attendees(token, event_id)

      print(f"  Fetching enrollments for session {session_id}...")
      enrollments = cvent.fetch_session_enrollments(token, session_id)
      print(f"  {len(enrollments)} enrollments found")

      if not dry_run:
          program_id = db.upsert_program(
              sb,
              client_id=client_id,
              name=session_config["name"],
              year=session_config["year"],
              format=session_config["format"],
              platform="cvent",
              platform_id=session_id,
              tag=session_config["tag"],
              instructor=session_config.get("instructor"),
          )

      for enr in enrollments:
          att_id = enr["attendee"]["id"]
          att = all_attendees.get(att_id)
          if not att:
              print(f"  WARNING: attendee {att_id} not found in event roster, skipping")
              continue

          status = STATUS_MAP.get(enr.get("status"), "registered")
          name = f"{att['firstName']} {att['lastName']}"

          if dry_run:
              print(f"  [DRY RUN] {name} <{att['email']}> → {session_config['name']} ({status})")
              continue

          contact_id = db.upsert_contact(sb, client_id, att["email"], att["firstName"], att["lastName"])
          db.upsert_enrollment(
              sb,
              client_id=client_id,
              program_id=program_id,
              contact_id=contact_id,
              status=status,
              enrolled_at=enr.get("registrationDate"),
              platform_enrollment_id=enr["id"],
              raw_data=enr,
          )
          if status == "registered":
              db.apply_tag(sb, contact_id, session_config["tag"])

      if not dry_run:
          print(f"  Done: {len(enrollments)} enrollments synced")


  def main() -> None:
      parser = argparse.ArgumentParser(description="Sync course enrollments into the mail tool database")
      parser.add_argument("--client", required=True, help="Client config name (e.g. cfa)")
      parser.add_argument("--platform", required=True, choices=["cvent"])
      parser.add_argument("--program-id", help="Single session ID to sync")
      parser.add_argument("--all-sessions", action="store_true", help="Sync all sessions in config")
      parser.add_argument("--dry-run", action="store_true", help="Print what would sync without writing")
      args = parser.parse_args()

      config = load_config(args.client)

      if args.dry_run:
          print("DRY RUN — no data will be written\n")
          sb = None
      else:
          sb = db.get_supabase()

      if args.platform == "cvent":
          session_ids = (
              list(config["sessions"].keys()) if args.all_sessions
              else [args.program_id]
          )
          if not session_ids or session_ids == [None]:
              parser.error("Provide --program-id or --all-sessions")

          for session_id in session_ids:
              if session_id not in config["sessions"]:
                  print(f"WARNING: session {session_id} not in config, skipping")
                  continue
              print(f"\nSyncing: {config['sessions'][session_id]['name']}")
              sync_cvent_session(sb, config, session_id, dry_run=args.dry_run)


  if __name__ == "__main__":
      main()
  ```

- [ ] **Step 4: Run tests to confirm they pass**

  ```bash
  cd scripts/enrollment-sync && python -m pytest tests/test_sync.py -v
  ```

  Expected: 3 tests pass.

- [ ] **Step 5: Run all tests together**

  ```bash
  cd scripts/enrollment-sync && python -m pytest tests/ -v
  ```

  Expected: 12 tests pass, 0 failures.

- [ ] **Step 6: Commit**

  ```bash
  git add scripts/enrollment-sync/sync.py scripts/enrollment-sync/tests/test_sync.py
  git commit -m "feat(enrollment-sync): add sync CLI entry point"
  ```

---

## Task 8: Dry-Run Verification Against Live Cvent

Confirm the script connects to Cvent and produces sensible output before any data is written.

**Files:** (none — operational verification only)

- [ ] **Step 1: Run a single-session dry run**

  ```bash
  cd scripts/enrollment-sync
  python sync.py --client cfa --platform cvent \
    --program-id 49b6e8b1-d7b8-44c9-b82d-f2bed03e418a \
    --dry-run
  ```

  Expected output:
  ```
  DRY RUN — no data will be written

  Syncing: Grade 1 Teaching - Renewal 2026 Online
    Authenticating with Cvent...
    Fetching attendees for event b90c7d57-...
    Fetching enrollments for session 49b6e8b1-...
    N enrollments found
    [DRY RUN] First Last <email@example.com> → Grade 1 Teaching - Renewal 2026 Online (registered)
    ...
  ```

  If you see a 429 from Cvent, wait 30 seconds and retry — rate limit on the attendees endpoint resets quickly.

- [ ] **Step 2: Run all-sessions dry run**

  ```bash
  python sync.py --client cfa --platform cvent --all-sessions --dry-run
  ```

  Expected: output for all 8+ sessions, each showing their roster. Review for correctness — names, emails, and grade assignments should look right.

- [ ] **Step 3: When dry run looks correct, run the live sync**

  ```bash
  python sync.py --client cfa --platform cvent --all-sessions
  ```

  Then verify in Supabase:

  ```sql
  select p.name, count(e.id) as enrolled
  from programs p
  join enrollments e on e.program_id = p.id
  group by p.name
  order by p.name;
  ```

  Expected: 8+ rows, each with a non-zero enrollment count.

---

## Historical Backfill (Post-Task-8)

Once Task 8 passes, run the sync against past Renewal events to seed trend data. Steps:

1. Log into Cvent admin, navigate to Events, and note the event IDs for Renewal 2024 and 2025 (and 2023 if available).
2. For each past event, add a corresponding block to `config/cfa.json` under a `"past_events"` key (or create `config/cfa-2025.json`, etc.) with the correct session IDs and year.
3. Run: `python sync.py --client cfa --platform cvent --all-sessions` for each past config.
4. Verify row counts in Supabase as in Task 8 Step 3.
