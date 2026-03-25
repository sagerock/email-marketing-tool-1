# Salesforce Permission Request for Email Marketing Integration

## Background

We have a Connected App using the **OAuth 2.0 Client Credentials Flow** that syncs Contacts and Leads into our email marketing platform. Currently the "Run As" user has **read-only** access, and some fields (like AccountId on Contact) are hidden due to field-level security.

We need to expand permissions so we can:
1. Read company names for Contacts (via the Account relationship)
2. Write back to Salesforce when our AI follow-up agent sends emails (log as Tasks)

## What We Need

### 1. Create a Permission Set called "Email Marketing Integration"

In Setup > Permission Sets > New:
- **Label:** Email Marketing Integration
- **API Name:** Email_Marketing_Integration

### 2. Grant Object Permissions

In the Permission Set, under Object Settings, grant:

| Object | Read | Create | Edit |
|--------|------|--------|------|
| Contacts | Yes | No | No |
| Leads | Yes | No | No |
| Accounts | Yes | No | No |
| Tasks | Yes | Yes | Yes |

(We only need to *read* Contacts/Leads/Accounts. We need to *create* Tasks to log AI-generated follow-up emails.)

### 3. Grant Field-Level Security

**Contact object — make these fields Visible (Read Access):**
- `AccountId` (Account Name) — this is the critical one we're missing

**Task object — make these fields Visible + Editable:**
- `Subject`
- `Description`
- `WhoId` (Name / Related Contact)
- `Status`
- `Priority`
- `ActivityDate`
- `Type`

### 4. Assign the Permission Set

Assign the Permission Set to the **"Run As" user** configured on the Connected App:
- Setup > App Manager > find the Connected App > Manage
- Check which user is set under "Client Credentials Flow > Run As"
- Go to that user's record > Permission Set Assignments > Add "Email Marketing Integration"

**Alternatively**, you can assign the Permission Set directly to the Connected App itself (Setup > App Manager > Manage > Permission Sets section).

## How to Verify

After making the changes, we can verify by running a Salesforce sync from our Settings page. The "Contacts" line should no longer show the `Account` relationship error, and we'll test Task creation from the AI follow-up agent.

## Notes

- Salesforce recommends Permission Sets over Profile changes (Profiles are being phased out)
- The "Run As" user's effective permissions = Profile + all assigned Permission Sets
- No changes to the Connected App's OAuth scopes are needed — the existing `api` scope covers CRUD operations
