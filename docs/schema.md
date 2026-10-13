# Database Schema — Key Entities & Relationships

## Overview
This document describes the core entities and their relationships in the BLECA SmartLabs Finance database. The schema follows strict conventions:
- **snake_case** table/column names via `@map`/`@@map`
- **Decimal(20,6)** for all monetary amounts
- **organization_id** on every business table (multi-tenant isolation)
- **Soft delete** via `deleted_at` (hard delete only for ephemeral tables)
- **Append-only** audit tables enforced by DB triggers

---

## Core Entity Groups

### 1. Identity & Access
```
User ◄───► Session
User ◄───► MfaDevice
User ◄───► LoginHistory
User ◄──► UserRole ◄──► Role ◄──► RolePermission ◄──► Permission(ModuleKey, PermissionAction)
User ◄──► Delegation (grantor/grantee)
AccessReview ◄──► AccessReviewItem (user + role at review time)
```

**Key Enums:**
- `UserStatus`: INVITED | ACTIVE | SUSPENDED | DEACTIVATED
- `PermissionAction`: VIEW | CREATE | EDIT | SUBMIT | APPROVE | REJECT | POST | REVERSE | EXPORT | CONFIGURE | ADMINISTER
- `ModuleKey`: 50+ modules (DASHBOARD_CEO, TRANSACTIONS, APPROVALS, BACKUP_ADMIN, etc.)

### 2. Organization & Dimensions
```
Organization (1) ◄──► (N) Location
Organization (1) ◄──► (N) Department
Organization (1) ◄──► (N) CostCentre
Organization (1) ◄──► (N) Project
Organization (1) ◄──► (N) FundingSource
Organization (1) ◄──► (N) Currency
```

**Key Enums:**
- `LocationType`: HEAD_OFFICE | OFFICE | LAB | WAREHOUSE | PROJECT_SITE | UNIVERSITY_FACILITY | PERMITTED_USE | REMOTE | OTHER
- `ProjectStatus`: DRAFT | ACTIVE | ON_HOLD | COMPLETED | CANCELLED | ARCHIVED
- `FundingSourceType`: UNRESTRICTED | RESTRICTED_GRANT | DESIGNATED | ENDOWMENT | CONTRACT_REVENUE | INTERNAL_ALLOCATION | OTHER

### 3. Treasury & Cash Management
```
Organization (1) ◄──► (N) TreasuryAccount
TreasuryAccount ◄──► Account (ledger account)
TreasuryAccount ◄──► Location
TreasuryAccount ◄──► FundingSource
TreasuryAccount (1) ◄──► (N) PaymentSchedule
TreasuryAccount ◄──► Transfer (source/destination)
TreasuryAccount ◄──► ReconciliationSession
```

**Key Enums:**
- `TreasuryAccountKind`: CASH | BANK | MOBILE_MONEY | PAYMENT_GATEWAY | PROJECT_FUND | GRANT_FUND | OTHER
- `TransferStatus`: DRAFT | SUBMITTED | APPROVED | PROCESSED | FAILED | REVERSED | CANCELLED

### 4. Accounting Core (Double-Entry)
```
FinancialPeriod (1) ◄──► (N) JournalEntry
JournalEntry (1) ◄──► (N) JournalLine
JournalLine ◄──► Account
JournalLine ◄──► Project/Department/CostCentre/Location/FundingSource (dimensions)
JournalEntry ◄──► Transaction (source)
JournalEntry ◄──► Invoice/Payment/Receipt/Transfer (source)

Account (hierarchical: parent_id self-ref)
Account ◄──► OpeningBalance (per period)
Account ◄──► AccountBalanceSnapshot (per period, per currency - cache)
```

**Key Enums:**
- `AccountType`: ASSET | LIABILITY | EQUITY | REVENUE | EXPENSE
- `NormalBalance`: DEBIT | CREDIT
- `JournalEntryType`: STANDARD | OPENING_BALANCE | ADJUSTMENT | REVERSAL | CORRECTION | CLOSING | SYSTEM
- `JournalEntryStatus`: DRAFT | SUBMITTED | APPROVED | REJECTED | POSTED | LOCKED | REVERSED | VOIDED
- `PeriodStatus`: OPEN | CLOSING | CLOSED | LOCKED | REOPEN_PENDING | REOPENED

### 5. Transactions & Documents
```
Transaction ◄──► JournalEntry (generated)
Transaction ◄──► TreasuryAccount
Transaction ◄──► Project/Department/CostCentre/Location/FundingSource
Transaction ◄──► Document (supporting)

Invoice ◄──► Customer/Supplier
Invoice ◄──► JournalEntry (posted)
Invoice ◄──► InvoiceLine ◄──► Account
Invoice ◄──► PaymentAllocation ◄──► Payment

Payment ◄──► TreasuryAccount
Payment ◄──► PaymentMethodLine
Payment ◄──► PaymentAllocation ◄──► Invoice
Payment ◄──► Receipt (optional)

Receipt ◄──► ReceiptLine ◄──► Invoice
```

**Key Enums:**
- `TransactionStatus`: DRAFT | SUBMITTED | APPROVED | REJECTED | POSTED | LOCKED | ADJUSTED | REVERSED | CANCELLED
- `InvoiceStatus`: DRAFT | SUBMITTED | APPROVED | REJECTED | SENT | PARTIALLY_PAID | PAID | OVERDUE | CANCELLED
- `PaymentStatus`: DRAFT | SUBMITTED | APPROVED | IN_PROCESSING | COMPLETED | FAILED | PARTIALLY_REVERSED | REVERSED | CANCELLED

### 6. Parties (Customers/Suppliers)
```
Party (1) ◄──► (0..1) Customer
Party (1) ◄──► (0..1) Supplier
Party (1) ◄──► (N) Contact
Party (1) ◄──► (N) PartyAddress
Party (1) ◄──► (N) CommunicationLog

Customer ◄──► CustomerCreditHold
Customer ◄──► CustomerReceivable ◄──► Invoice
Customer ◄──► Quotation
Customer ◄──► Invoice

Supplier ◄──► SupplierBankDetail
Supplier ◄──► SupplierBankDetailChangeRequest (approval-gated)
Supplier ◄──► SupplierProductService
Supplier ◄──► Invoice
Supplier ◄──► Payment
```

### 7. Budget & Commitments
```
Budget ◄──► BudgetLine ◄──► Account
BudgetLine ◄──► Commitment
Budget ◄──► BudgetRevision ◄──► BudgetRevisionLine (before/after)
Budget ◄──► BudgetTransfer (between lines)
Budget ◄──► BudgetScenario (what-if)
```

**Key Enums:**
- `BudgetLevel`: COMPANY | DEPARTMENT | PROJECT | FUNDING | ACTIVITY
- `CommitmentSource`: INVOICE | PURCHASE_COMMITMENT | CONTRACT | PAYMENT_SCHEDULE | MANUAL

### 8. Audit & Security (Append-Only)
```
AuditLog (append-only, hash-chained)
  sequence (BigInt, autoincrement, unique)
  previous_hash (SHA-256 of prior entry)
  entry_hash (SHA-256 of this entry)
  signature (HMAC-SHA256 with period key)

AuditChainHead (single row, SELECT FOR UPDATE serializes writes)
  sequence, entry_hash, updated_at

AuditChainCheckpoint (daily seals)
  period_start, period_end, sealed_through_sequence, status

SecurityEvent ◄──► AuditLog (optional link)
```

**Key Enums:**
- `AuditAction`: 100+ actions (LOGIN, TRANSACTION_POSTED, BACKUP_VERIFIED, RESTORE_TEST, ...)
- `AuditEntityType`: 80+ entity types
- `SecurityEventType`: BRUTE_FORCE_ATTEMPT, SOD_VIOLATION_ATTEMPT, AUDIT_CHAIN_BROKEN, OFFLINE_QUEUE_REPLAY_ATTEMPT, ...
- `SecurityEventSeverity`: INFO | LOW | MEDIUM | HIGH | CRITICAL

### 9. Import & Reconciliation
```
ImportBatch (7-stage: UPLOADED → MAPPING → VALIDATING → PREVIEW → AWAITING_APPROVAL → APPROVED → IMPORTING → COMPLETED)
  ◄──► ImportRow (raw → mapped → normalized)
  ◄──► ImportFieldMapping (column maps per source)
  ◄──► ImportError

ReconciliationSession ◄──► ReconciliationMatch (PROPOSED → CONFIRMED)
  ◄──► ReconciliationException
  ◄──► ReconciliationAdjustment (approval-gated → JournalEntry)
```

### 10. Approvals (Generic Workflow)
```
ApprovalPolicy (per entity type, ordered steps)
  ◄──► ApprovalPolicyStep (assignee: ROLE/USER, resolution: ANY/ALL/QUORUM)

ApprovalRequest (per entity instance)
  ◄──► ApprovalStepInstance (per step)
    ◄──► ApprovalDecisionRecord (per decision)
  ◄──► SODWaiver (if submitter = approver)

ApprovalEntityType: TRANSACTION | JOURNAL_ENTRY | INVOICE | PAYMENT | PERIOD_REOPEN | FINANCIAL_CLOSE | ...
```

### 11. Financial Close
```
FinancialClose (per period)
  ◄──► CloseChecklistItem (per CloseItemKey)
    ◄──► ApprovalRequest (for reopen)
```

**CloseItemKey (PDF §64):**
BANK_RECONCILIATION | CASH_RECONCILIATION | RECEIVABLES | PAYABLES | MISSING_DOCUMENTS | UNAPPROVED_TRANSACTIONS | BUDGET_VARIANCES | ADJUSTMENTS | FINANCIAL_STATEMENTS | OPEN_ITEMS_DISCLOSED | GO_LIVE_CLEANUP

### 12. Tax & Compliance
```
TaxRule (configurable, jurisdictional)
  ◄──► TaxObligation (per period)
    ◄──► TaxPayment ◄──► JournalEntry ◄──► Document

Credential (registrations, licenses, certifications)
  ◄──► ComplianceDocument ◄──► Document
```

### 13. PWA / Offline Sync
```
SyncQueueItem (client-generated idempotency_key)
  actionType: RECEIPT_CAPTURE | DRAFT_SAVE | CONTACT_CARD_SAVE | [online-only actions]
  status: QUEUED | SYNCING | SYNCED | CONFLICT | FAILED | DISCARDED
```

### 14. Backup & Disaster Recovery
```
BackupRun
  type: FULL | INCREMENTAL | POINT_IN_TIME
  status: SCHEDULED | RUNNING | SUCCEEDED | FAILED | VERIFIED | VERIFICATION_FAILED | EXPIRED
  storageKey, checksum (SHA-256), sizeBytes, rowCounts (JSON), auditChainHead
  verifiedAt, verificationChecksum
  restoreTestedAt, restoreTestResult (JSON)
```

---

## Critical Relationships Diagram

```
Organization
  │
  ├─► User (membership)
  ├─► Location / Department / CostCentre / Project / FundingSource
  ├─► Currency / ExchangeRate
  ├─► TreasuryAccount ──► Account (ledger)
  │       │
  │       ├─► PaymentSchedule
  │       ├─► Transfer
  │       └─► ReconciliationSession
  │
  ├─► Account (hierarchical)
  │       │
  │       ├─► JournalLine ◄── JournalEntry ◄── FinancialPeriod
  │       │       │                │
  │       │       │                ├─► Transaction
  │       │       │                ├─► Invoice / Payment / Receipt / Transfer
  │       │       │                └─► OpeningBalance
  │       │       │
  │       │       └─► Dimensions (Project, Dept, CostCentre, Location, Funding)
  │       │
  │       └─► AccountBalanceSnapshot (cache)
  │
  ├─► Party ──► Customer / Supplier
  │       │       │
  │       │       ├─► Invoice ◄── PaymentAllocation ◄── Payment
  │       │       │       │
  │       │       │       └─► CreditNote / DebitNote
  │       │       │
  │       │       └─► Quotation
  │       │
  │       ├─► SupplierBankDetail ◄── SupplierBankDetailChangeRequest
  │       └─► Contact / PartyAddress / CommunicationLog
  │
  ├─► Budget ──► BudgetLine ◄── Commitment
  │       ├─► BudgetRevision / BudgetTransfer / BudgetScenario
  │
  ├─► Document ──► DocumentVersion (append-only)
  │       ├─► DocumentLink (polymorphic to any entity)
  │       └─► RetentionPolicy / LegalHold
  │
  ├─► AuditLog ◄── SecurityEvent
  │       ├─► AuditChainHead / AuditChainCheckpoint
  │
  ├─► ImportBatch ──► ImportRow / ImportError / ImportFieldMapping
  │       └─► ReconciliationSession
  │
  ├─► ApprovalPolicy ──► ApprovalRequest ──► ApprovalStepInstance
  │       └─► SODWaiver
  │
  ├─► FinancialClose ──► CloseChecklistItem
  │
  ├─► TaxRule ──► TaxObligation ──► TaxPayment
  │
  ├─► BackupRun
  └─► SyncQueueItem
```

---

## Naming Conventions Summary

| Element | Convention | Example |
|---------|------------|---------|
| Table | snake_case, plural | `journal_entries` |
| Column | snake_case | `created_at`, `organization_id` |
| PK | `id` (CUID) | `id` |
| FK | `{table}_id` | `account_id`, `period_id` |
| Unique composite | `{table}_{column}_key` | `organization_id_code` |
| Index | `{table}_{column}_idx` | `journal_entries_period_id_status_idx` |
| Enum values | UPPER_SNAKE_CASE | `JOURNAL_ENTRY_POSTED` |
| Boolean | `is_`/`has_`/`can_` prefix | `is_active`, `has_role` |
| Timestamps | `_at` suffix | `created_at`, `posted_at`, `deleted_at` |

---

## Migration Strategy

1. **All schema changes via Prisma migrations** (`npx prisma migrate dev`)
2. **Migration names**: `<milestone>_<feature>` (e.g., `m17_pwa_backups`)
3. **Destructive changes**: Require manual SQL migration + data backfill plan
4. **Enum additions**: New values only at end (never reorder)
5. **Index additions**: Safe, can be added anytime
6. **Column additions**: Nullable or with default (never breaking)

---

## Revision History

| Date | Version | Author | Changes |
|------|---------|--------|---------|
| 2026-10-13 | 1.0 | System | Initial version for M17 |