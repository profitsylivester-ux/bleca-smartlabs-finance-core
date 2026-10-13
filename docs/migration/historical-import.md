# Historical Data Migration

## Overview
This document describes the process for migrating BLECA's bootcamp records, invoices, and other historical financial data into the BLECA SmartLabs Finance system.

## Background
Per PDF §2, the bootcamp produced ~TZS 3,900,000 gross "before expenses were properly recorded." This is a **one-sided, partially-entered historical position** with known-incomplete expense side. The import must:
- Preserve original information, source, import date, verification status, migration history
- Flag all imported records as `isUnverified = true` and `verificationStatus = UNVERIFIED`
- Use the M8 import pipeline (7-stage gated process)
- Create audit trail for traceability

## Migration Tool
**Script:** `scripts/migrate-historical.ts`
**Usage:**
```bash
npx tsx scripts/migrate-historical.ts path/to/historical-data.csv [--dry-run] [--batch-size N]
```

## CSV Format Specification

### Required Columns (Header Row Mandatory)
| Column | Type | Required | Description |
|--------|------|----------|-------------|
| `date` | ISO Date (YYYY-MM-DD) | Yes | Transaction date |
| `description` | String | Yes | Transaction description |
| `reference` | String | Yes | External reference number |
| `amount` | Decimal (positive) | Yes | Transaction amount |
| `currency` | String (3-letter) | Yes | Currency code (TZS, USD, EUR, GBP) |
| `account_code` | String | Yes | Chart of Accounts code (must exist in CoA) |

### Optional Columns
| Column | Type | Description |
|--------|------|-------------|
| `project_code` | String | Project code (must exist) |
| `department_code` | String | Department code (must exist) |
| `cost_centre_code` | String | Cost centre code (must exist) |
| `funding_source_code` | String | Funding source code (must exist) |
| `payment_method` | Enum | CASH, BANK_TRANSFER, MOBILE_MONEY, PAYMENT_GATEWAY, CHEQUE, CARD, OTHER (default: CASH) |
| `source_document_id` | String | Document ID for supporting evidence (optional) |

### Example CSV
```csv
date,description,reference,amount,currency,account_code,project_code,department_code,cost_centre_code,funding_source_code,payment_method,source_document_id
2024-01-15,"Bootcamp revenue","BOOTCAMP-2024-001",3900000,TZS,REVENUE_TRAINING,IVENTIKA,,,,CASH,
2024-02-20,"Laptop purchase for Uzanite","INV-2024-045",1200000,TZS,EQUIPMENT,UZANITE,,,,BANK_TRANSFER,DOC-001
2024-03-10,"Internet bill","INV-2024-067",150000,TZS,EXPENSE_INTERNET,,,,,MOBILE_MONEY,DOC-002
2024-04-05,"Cloud hosting","INV-2024-089",450000,TZS,EXPENSE_CLOUD,IVENTIKA,,,,BANK_TRANSFER,
2024-05-12,"Marketing campaign","INV-2024-112",750000,TZS,EXPENSE_MARKETING,UZANITE,,,,CASH,DOC-003
```

## Pre-Migration Checklist

### 1. Chart of Accounts Setup
Ensure all `account_code` values exist in the CoA. The seed includes PDF §7 mandated accounts:
- Revenue: `REVENUE_TRAINING`, `REVENUE_CONSULTING`, `REVENUE_SOFTWARE`, `REVENUE_SAAS`, etc.
- Expense: `EXPENSE_INTERNET`, `EXPENSE_CLOUD`, `EXPENSE_AI_API`, `EXPENSE_TRANSPORT`, etc.
- Assets: `CASH`, `BANK`, `MOBILE_MONEY`, `EQUIPMENT`, `INVENTORY`
- Equity: `CAPITAL`, `RETAINED_EARNINGS`, `FUTURE_INVESTMENT`

### 2. Dimensions Setup
Create any referenced dimensions:
```bash
# Projects (IVENTIKA, UZANITE)
# Departments
# Cost Centres
# Funding Sources
```

### 3. Supporting Documents
Upload supporting documents (receipts, invoices) first and note their Document IDs for the `source_document_id` column.

## Migration Process

### Step 1: Dry Run Validation
```bash
npx tsx scripts/migrate-historical.ts ./data/historical.csv --dry-run
```
This validates all rows without importing. Check output for:
- Missing accounts/dimensions
- Invalid dates/amounts/currencies
- Unknown payment methods

### Step 2: Execute Migration
```bash
npx tsx scripts/migrate-historical.ts ./data/historical.csv --batch-size 50
```
- Creates an `ImportBatch` with status `APPROVED`
- Creates `ImportRow` entries for each CSV row
- Processes each row through the import pipeline
- Creates `Transaction` records with `status = DRAFT` and `isUnverified = true`

### Step 3: Verification
After import, verify in the application:
1. Go to **Imports** → Find batch `HIST-<timestamp>`
2. Review imported transactions
3. Each transaction will have:
   - Status: `DRAFT` (not submitted/posted)
   - Verification: `UNVERIFIED`
   - Metadata: `migrationNote` with source row reference

### Step 4: Accountant Review
A qualified accountant must:
1. Review each unverified transaction
2. Attach supporting documents
3. Verify against source records
4. Update `verificationStatus` to `VERIFIED` when satisfied
5. Submit → Approve → Post through normal workflow

## Data Model Impact

### Transaction Fields Set by Migration
| Field | Value |
|-------|-------|
| `status` | `DRAFT` |
| `isUnverified` | `true` (via metadata) |
| `verificationStatus` | `UNVERIFIED` |
| `source` | `HISTORICAL_MIGRATION` |
| `migrationNote` | `Imported from historical CSV row N` |
| `createdById` | CEO user (from seed) |

### Audit Trail
The migration creates:
1. `ImportBatch` record (type: CSV, source: HISTORICAL_MIGRATION)
2. `ImportRow` for each CSV row (with rawData, normalizedData, fingerprint)
3. `AuditLog` entries: `IMPORT_EXECUTED` for batch, `TRANSACTION_CREATED` for each transaction
4. `SecurityEvent`: None (routine import)

## Verification Requirements

Per PDF §2 and §52, historical data **must preserve**:
- ✅ Original information (raw CSV row stored in `ImportRow.rawData`)
- ✅ Source (CSV filename, row number, `migrationNote`)
- ✅ Import date (batch `createdAt`)
- ✅ Verification status (`UNVERIFIED` by default)
- ✅ Migration history (import batch ID, audit trail)

## Post-Migration Reporting

### Unverified Transactions Report
```sql
SELECT t.id, t.date, t.description, t.amount, t.currency_code, t.status
FROM transactions t
JOIN import_rows ir ON ir.imported_transaction_id = t.id
JOIN import_batches ib ON ib.id = ir.batch_id
WHERE ib.code LIKE 'HIST-%'
AND t.status = 'DRAFT';
```

### Trial Balance Impact
Unverified transactions in `DRAFT` status **do not affect** trial balance or GL until posted. They remain invisible to financial reports until submitted/approved/posted through the normal workflow.

## Rollback Procedure

If migration needs to be rolled back:
1. Find the `ImportBatch` (code like `HIST-<timestamp>`)
2. Get all `ImportRow` with `importedTransactionId`
3. Delete those `Transaction` records (they're in DRAFT, so no audit chain issues)
4. Delete `ImportRow` and `ImportBatch` records
5. Audit log will show the deletions

## Known Limitations

1. **One-sided entries**: The bootcamp revenue (TZS 3,900,000) has incomplete expenses. Each migrated transaction is a single-sided entry that will need a corresponding entry when verified.

2. **No journal entries created**: Migration creates `Transaction` records only. Journal entries are generated when transactions are posted.

3. **Opening balances not set**: For true opening balances, use the Opening Balance module after verification.

4. **MFA not required for script**: The script runs with CEO credentials from seed. In production, run with a dedicated migration service account.

## Support

For issues with migration:
1. Check `--dry-run` output for validation errors
2. Ensure all referenced accounts/dimensions exist
3. Verify CSV encoding is UTF-8
4. Check database connectivity (`DATABASE_URL`)

## Revision History

| Date | Version | Author | Changes |
|------|---------|--------|---------|
| 2026-10-13 | 1.0 | System | Initial version for M17 |