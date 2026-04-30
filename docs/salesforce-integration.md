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

## Order/OrderItem Integration

Salesforce Orders are accessible and have been characterized. Verified 2026-04-30.

**Objects accessible to the integration user:**

| Object | API Name | Label | Records (as of 2026-04-30) |
|--------|----------|-------|----------------------------|
| Order | `Order` | Order | 149 |
| Order Line Item | `OrderItem` | Order Product | 239 |
| Price Book | `Pricebook2` | Price Book | 1 (standard) |
| Price Book Entry | `PricebookEntry` | Price Book Entry | 100 |

**Diagnostic endpoint:** `GET /api/salesforce/diagnose-orders?clientId={id}` — returns per-object describe results, row counts, and a plain-English diagnosis. Useful for verifying after permission changes.

### How Alconox actually uses Salesforce Orders

Salesforce Orders is a **fulfillment / shipping tracker**, not a revenue or billing system.

Evidence from the data:
- **All 149 orders have `TotalAmount = $0`**, every `OrderItem.UnitPrice = $0`, every `OrderItem.TotalPrice = $0`. Universal across the dataset, not a sampling artifact.
- **Status distribution:** 146 `Shipped`, 2 `Activated`, 1 `Draft` — essentially every order is a record of something that went out the door.
- **Date range:** 2025-11-17 → 2026-04-28 (~5.5 months); sequential `OrderNumber` from `00000104` to `00000256`.
- Products and quantities are real (e.g., Liquinox® S12018 — 35 lines, 57 units; Detonox® S23018 — 33 lines, 48 units).
- Accounts linked to orders are real customers (Hackensack University Medical Center, Intel Corporation, Sanofi Swiftwater, Stallergenes Greer, etc.).

Revenue data lives elsewhere — most likely the WooCommerce store.

### What Orders are useful for

| Use case | Viable? |
|----------|---------|
| Cross-sell / upsell ("ordered X but not Y") | ✓ |
| Reorder reminders (`EffectiveDate` + product) | ✓ |
| Product-affinity segments (medical-device vs. lab detergent customers) | ✓ |
| Active-customer flagging (anyone with a recent shipped order) | ✓ |
| Revenue / monetary segmentation (RFM, LTV, top spenders) | ✗ Data not present |
| Average order value | ✗ Data not present |

### Field reference

| Field | Type | Notes |
|-------|------|-------|
| `Order.Id` | Id | Primary key |
| `Order.OrderNumber` | string | Auto-incremented; **use this** as user-facing ID |
| `Order.Name` | string | **Always null** in this org — don't use |
| `Order.Status` | picklist | Practical values: `Shipped`, `Activated`, `Draft` |
| `Order.EffectiveDate` | date | Use for recency / reorder timing |
| `Order.AccountId` | Id | Joins to Account.Name (real customer names) |
| `Order.TotalAmount` | currency | **Always $0** in this org |
| `OrderItem.OrderId` | Id | Parent order |
| `OrderItem.Quantity` | number | Real units shipped |
| `OrderItem.UnitPrice` / `TotalPrice` | currency | **Always $0** in this org |
| `OrderItem.Product2Id` | Id | Joins to Product2.Name + Product2.ProductCode |

### Integration status

No code path syncs Orders into Supabase yet. Next step: decide whether to denormalize purchase signals onto `contacts` (e.g., `last_order_date`, `top_product_codes` array) or create a `salesforce_orders` table for richer queries.

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
