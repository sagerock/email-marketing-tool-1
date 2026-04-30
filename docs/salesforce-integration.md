# Salesforce Integration — Email Marketing Tool

## Overview

The email marketing tool syncs contact and lead data from Alconox's Salesforce org via an **OAuth 2.0 Client Credentials** Connected App. No user login is required — the integration runs as a dedicated "Run As" user whose permissions determine what data is accessible.

Synced data is stored in the `contacts` table in Supabase and used to power audience segmentation, automation triggers, and campaign filtering.

---

## Connected App Setup

| Setting | Value |
|---------|-------|
| OAuth Flow | Client Credentials (no callback URL needed) |
| OAuth Scope | `api` (full read/write access governed by Run As user permissions) |
| Credentials | Stored per-client in `clients.salesforce_client_id` / `salesforce_client_secret` |
| Instance URL | `https://alconox.my.salesforce.com` |
| Token Endpoint | `{instance_url}/services/oauth2/token` |

The Connected App's **"Run As" user** has a Permission Set called **"Email Marketing Integration"** assigned, which grants exactly the access the integration needs.

---

## Objects Synced

### Leads → `contacts` (record_type = 'lead')

| Salesforce Field | DB Column | Notes |
|-----------------|-----------|-------|
| `Id` | `salesforce_id` | |
| `Email` | `email` | Required; leads without email are skipped |
| `FirstName` / `LastName` | `first_name` / `last_name` | |
| `Company` | `company` | |
| `Industry` | `industry` | |
| `Source_code__c` | `source_code` | Custom field |
| `Source_Code_History__c` | (parsed) | Long-textarea, client-side parsed for web orders |
| `Product_Classification__c` | `product_classification` | |
| `State` / `Country` | `state` / `country` | |
| `CreatedDate` | `created_at` | |

### Contacts → `contacts` (record_type = 'contact')

All Lead fields above, plus:

| Salesforce Field | DB Column | Notes |
|-----------------|-----------|-------|
| `Account.Name` | `company` | Requires Account Read permission |
| `Account.Type` | `account_type` | See dealer detection below |
| `Type__c` | `contact_type` | Contact-level type (e.g., "Customer", "Dealer") |
| `Industry__c` | `industry` | Custom field on Contact (vs. standard on Lead) |
| `Source_Code1__c` | `source_code` | |
| `MailingState` / `MailingCountry` | `state` / `country` | |

The sync falls back to a Contact query without Account fields if Account access is denied, so it degrades gracefully.

---

## Dealer Detection

Alconox tracks dealers at two levels, and the integration uses both:

| Signal | Salesforce Source | DB Column | Coverage |
|--------|------------------|-----------|----------|
| Contact-level | `Contact.Type__c = 'Dealer'` | `contact_type` | ~43% of dealer contacts |
| Account-level | `Account.Type = 'Dealers'` | `account_type` | Covers the remaining ~57% |

**Mapping at sync time:**

```javascript
contact_type: contact.Type__c || null,
account_type: contact.Account?.Type === 'Dealers' ? 'Dealer' : (contact.Account?.Type || null),
```

Note: Salesforce stores the Account type as `'Dealers'` (plural); we normalize to `'Dealer'` (singular) in the DB.

**Audience filter logic:**

- **Dealer audience**: contacts where `account_type = 'Dealer'` OR `contact_type = 'Dealer'`
- **Customer audience**: contacts where `contact_type = 'Customer'` AND `account_type` is not `'Dealer'`

This expanded the dealer-accessible audience from ~632 to ~1,200+ contacts compared to using only the contact-level type field.

---

## Sync Schedule

- **Daily at 6 AM UTC** via node-cron — incremental sync (only records modified since `last_salesforce_sync`)
- **Manual sync** available from the Settings page — full or incremental
- **Full sync** re-fetches all records regardless of modification date

Incremental sync uses Salesforce's `WHERE LastModifiedDate >= {timestamp}` filter.

---

## Permission Set: "Email Marketing Integration"

Assigned to the Connected App's Run As user. Current grants:

| Object | Read | Create | Edit |
|--------|------|--------|------|
| Contact | ✓ | | |
| Lead | ✓ | | |
| Account | ✓ | | |
| Campaign | ✓ | | |
| CampaignMember | ✓ | | |
| Task | ✓ | ✓ | ✓ |

**Field-level access on Contact:**
- `AccountId` (enables Account.Name and Account.Type via relationship query)
- `Type__c`, `Industry__c`, `Source_Code1__c`, `Source_Code_History__c`, `Product_Classification__c`

---

## Order/OrderItem Integration (In Progress)

We are investigating whether Salesforce Orders can serve as a source for purchase history.

**Objects involved:**

| Object | API Name | Label | Status |
|--------|----------|-------|--------|
| Order | `Order` | Order | Permission pending |
| Order Line Item | `OrderItem` | Order Product | Permission granted |
| Price Book | `Pricebook2` | Price Book | Permission granted |
| Price Book Entry | `PricebookEntry` | Price Book Entry | Permission granted |

**Current blocker:** OrderItem count and sample queries return empty. Likely cause is one of:
1. `Order` object (parent of `OrderItem`) does not have Read permission on the Run As user — granting `OrderItem` without `Order` returns no rows
2. Orders feature is not enabled at the org level (Setup → Order Settings → Enable Orders)
3. No Order records exist in the org yet

**Diagnostic endpoint:** `GET /api/salesforce/diagnose-orders?clientId={id}`

Returns per-object describe results, row counts, and a plain-English diagnosis. Run this after the admin confirms Order permissions are set.

**What we need from the admin:**
- Confirm `Order` object Read access is included in the permission set (not just `OrderItem`)
- Confirm Orders is enabled: Setup → Order Settings → "Enable Orders" checkbox
- If orders are tracked differently (e.g., via a custom object or WooCommerce separately), let us know

---

## API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /api/salesforce/connect` | Store credentials and verify connection |
| `GET /api/salesforce/status` | Check connection status |
| `POST /api/salesforce/disconnect` | Remove connection |
| `GET /api/salesforce/fields` | List fields for Lead/Contact (or any object via `?object=X`) |
| `GET /api/salesforce/list-objects` | List all queryable objects visible to integration user |
| `GET /api/salesforce/access-report` | Full markdown report of accessible objects/fields |
| `GET /api/salesforce/diagnose-orders` | Diagnose Order/OrderItem access specifically |
| `POST /api/salesforce/sync` | Trigger incremental or full sync |
| `POST /api/salesforce/sync-campaigns` | Sync Campaigns and CampaignMembers |
| `GET /api/salesforce/preview` | Preview sync results without writing to DB |

---

## Database Schema

Key columns on `contacts` table added for Salesforce integration:

```sql
salesforce_id        text              -- SF record Id
record_type          text              -- 'lead' or 'contact'
source_code          text              -- Source_code__c / Source_Code1__c
industry             text              -- Industry / Industry__c
contact_type         text              -- Type__c (contact-level)
account_type         text              -- derived from Account.Type
product_classification text
```

Migration files: `supabase/migrations/` — see `038_add_contact_type.sql`, `046_add_account_type.sql`.

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `invalid_client` on connect | Wrong Client ID or Secret | Re-copy from Salesforce Connected App → Manage Consumer Details |
| `unauthorized_client` | Client Credentials Flow not enabled on Connected App | Salesforce Setup → App Manager → Edit Policies → Enable Client Credentials Flow |
| Account fields null after sync | Account Read not in permission set | Admin adds Account object to permission set |
| `Account.Type` always null | Field-level security on Account.Type blocked | Admin grants FLS Read on `Account.Type` |
| OrderItem query returns empty | See Order/OrderItem section above | Run `/api/salesforce/diagnose-orders` for specific error |
| Sync misses records | Incremental based on `LastModifiedDate` | Run Full Sync to re-fetch everything |
