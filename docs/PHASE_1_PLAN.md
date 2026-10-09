# BLECA SmartLabs Finance — Phase 1 Implementation Plan

**Document status:** Plan only. No application code has been written.
**Source of truth:** `BLECA_SMARTLABS_financial_website_requirements.pdf` (57 pages, Sections 1–76) and `BUILD_PROMPT.md`
**Stage:** Approved in principle. All §9.1 open questions answered. **Awaiting the literal instruction "start M1" before any code is written.**
**Scope:** Phase 1 only (PDF §70 "PHASE 1 — MUST HAVE", 27 items) plus the Phase 1 support items mandated by `BUILD_PROMPT.md` §5.

---

## 1. Confirmation of Full PDF Read + Details That Are Easy To Miss

I read the entire `BLECA_SMARTLABS_financial_website_requirements.pdf` end-to-end — all 57 pages, all 76 numbered sections, from "1. PURPOSE OF THE WEBSITE" through "76. FINAL TECHNICAL DIRECTION". Extraction was verified page-by-page: 57/57 pages extracted, 0 errors, no gaps, terminal section confirmed present.

Below are 10 specific details from the spec that are easy to skim past. Each one changes a design decision — none is generic filler.

1. **BLECA is not yet registered and has no permanent premises** (PDF §2). Concretely: ~20 university students/team members, operating from **Mbeya**, using *university facilities with permission*, with **no dedicated permanent laboratory**. Design consequence: `Location` must model a *permitted-use, third-party* location type (not only owned premises), and the organization/tax records must tolerate `registrationStatus = NOT_REGISTERED` with a nullable TIN. The compliance module cannot assume a TIN exists on day one.

2. **The bootcamp produced ~TZS 3,900,000 gross "before expenses were properly recorded"** (PDF §2). This is the single most important real dataset for the `unverified / historical` requirement — a revenue figure with a *known-incomplete* expense side. Design consequence: the opening-balance/import path must accept a **one-sided, partially-entered historical position** flagged unverified, and reports must visibly mark such figures as unverified rather than presenting them as accurate.

3. **Funding priority is explicitly ordered** (PDF §2): grants, competitions, sponsorships and partnerships **before** equity investment; target ~TZS 10,000,000. Design consequence: `FundingSource` must model restriction semantics from day one (restricted vs unrestricted funds, eligible-expense tracking), even though the *Funding module* itself is Phase 2 — because Phase 1 budgets and transactions already need `fundingSource` as a dimension.

4. **Two named live projects already exist: Iventika and Uzanite** (PDF §2, restated in §33). Design consequence: `Project` ships as a *real, usable* dimension in Phase 1, not an empty stub, because Phase 1 budgets, transactions and invoices are project-dimensioned per `BUILD_PROMPT.md` §5.

5. **The Chart of Accounts must pre-reserve accounts for modules that are NOT being built** (PDF §7). The mandated CoA explicitly lists **Inventory** and **Equipment** under Assets, "Future investment/equity accounts" under Equity/Net Assets, and revenue lines for **SaaS, token-based services, component sales, electronics, hardware**. Design consequence: the Phase 1 CoA seed creates these accounts **active but dormant**, so Phase 2 plugs in without a chart rebuild (PDF §17.17). This directly contradicts a naive "add accounts as you need them" approach and is the most commonly missed requirement in the spec.

6. **Transfers must never distort the P&L** (PDF §10, verbatim): *"Transfers between accounts must not incorrectly appear as revenue or expenses."* Design consequence: a transfer is **not** a revenue/expense object — it is a paired multi-line journal entry whose lines offset. `Transfer` is an aggregate *view* over `JournalEntry`, never an independent writer of ledger truth. This is the classic double-entry failure mode for a system running both cash and mobile money.

7. **The import pipeline is a fixed seven-step gate with a five-field provenance contract** (PDF §52): `Upload → Map Fields → Validate → Preview → Detect Duplicates → Approve → Import`, failed records to an **error queue**. Historical data must preserve **original information, source, import date, verification status, migration history**. Design consequence: import is a staged, human-approved pipeline with its own tables (`ImportBatch`, `ImportRow`, `ImportError`) — not a "upload CSV" endpoint. Those five provenance fields must be columns on imported rows, not merely log lines.

8. **"AI may flag anomalies but shall not independently accuse a person or make a consequential decision"** (PDF §65) — stronger than the general rule in PDF §30. Design consequence: `AnomalyFlag` deliberately has **no `accusedUserId`** and no automatic workflow transition. Flagging alone must never auto-reject, auto-hold or auto-block money; a named human must acknowledge it before any effect. The subject is the record, not a person.

9. **Phase 1 must include features that depend on Phase 2 modules** (PDF §70–72 vs §12, §47). Phase 1 reconciliation must support **payment gateways, project funds and grants** — all Phase 2 modules. The Phase 1 report list includes an **Asset register** report, but Assets is Phase 2. Design consequence: reconciliation sessions and the report registry are **generic over an account-kind dimension**, and the report engine can express "report declared but its module is not built" rather than a hardcoded list that breaks later.

10. **Offline has a hard boundary** (PDF §58): queued non-critical actions are fine, but *"High-risk financial approvals and final posting should require connectivity whenever practical."* Design consequence: the offline queue is an **allowlist** (`RECEIPT_CAPTURE`, `DRAFT_SAVE`), with submit/approve/reject/post/reverse/period-close/period-reopen **structurally excluded**. Offline mutations carry client-generated idempotency keys so duplicate prevention (PDF §58) survives sync.

**Also noted, cross-cutting:**

11. **PDF §74 defines the dependency order** — Finance → Projects → Customers → Suppliers → Funding → Operations → Intelligence → Complete Organization — and states the system *"should never become a collection of disconnected pages"*, sharing nine substrates: Users, Permissions, Organizations, Projects, Documents, Notifications, Audit trail, APIs, Reporting, Financial data. These are **not Phase 1 modules** — they are platform services built once in Phase 1 and consumed by every future module. Any Phase 1 module storing its own copy of "user list", "notification sending" or "document reference" is an architectural defect.

12. **A phasing conflict in the source documents.** The PDF's own phase table puts **Notifications** and **Compliance** in Phase 2 (PDF §71), while `BUILD_PROMPT.md` §5 requires **notifications (in-app + email minimum)** and a **configurable tax engine** as Phase 1 support items. The PDF body (§46, §32) treats both as unconditional "shall" requirements. I am resolving in favour of `BUILD_PROMPT.md` (build the minimum versions now: in-app + email notifications; a fully configurable tax engine) and have raised this as **Open Question Q1** in §9 rather than deciding silently.

---

## 2. High-Level Architecture

### 2.1 Platform shape

Next.js App Router + TypeScript on Vercel with Neon or Supabase Postgres. Server Components for read paths, Server Actions for mutations, Route Handlers under `app/api/v1/**` for the external API surface, and TanStack Query only for genuinely client-interactive, high-refresh views (reconciliation workbench, dashboards with live figures, global-search type-ahead).

This is a **single Next.js deployment with internal module boundaries**, not a monorepo of services. BLECA's Phase 1 team (2 users) and budget do not justify microservices, and splitting into disconnected front ends would violate PDF §74. Module boundaries are therefore enforced by **directory structure, import-graph discipline and a shared kernel contract**, not network boundaries.

### 2.2 Kernel / module separation (the decision that matters most)

The critical requirement is "future modules plug into the accounting core without rebuild" (PDF §17.17, §74). That is delivered by a strict **one-way dependency rule**:

```
  ┌────────────────────────────────────────────────────────────┐
  │  PRESENTATION      app/** route segments, layouts, views   │
  └──────────────────────────┬─────────────────────────────────┘
                             │
  ┌──────────────────────────▼─────────────────────────────────┐
  │  MODULE LAYER        modules/<module>/                      │
  │  server actions · queries · zod schemas · service wrappers │
  │  MAY import from kernel.  NEVER imported BY the kernel.     │
  │  NEVER imports another module's internals.                   │
  └──────────────────────────┬─────────────────────────────────┘
                             │  one direction only
  ┌──────────────────────────▼─────────────────────────────────┐
  │  ACCOUNTING & PLATFORM KERNEL        lib/                  │
  │    accounting  posting, balance, GL, trial balance        │
  │    periods     open / close / lock / reopen               │
  │    approvals   generic workflow engine                    │
  │    rbac        server-side authorization                   │
  │    audit       append-only tamper-evident log             │
  │    documents   pluggable storage abstraction               │
  │    fx          currency + historical rates                 │
  │    dimensions  project / dept / cost centre / location     │
  │    notifications · tax · money · workflow · import · search│
  └──────────────────────────┬─────────────────────────────────┘
                             │
  ┌──────────────────────────▼─────────────────────────────────┐
  │  INFRASTRUCTURE    prisma · storage · email · queue ·       │
  │                    cache · rate-limit · structured logging   │
  └────────────────────────────────────────────────────────────┘
```

**How the one-way rule is actually enforced (not just convention):**
- ESLint `no-restricted-imports` zones: files under `lib/**` may not import from `modules/**` or `app/**`.
- Cross-module interaction goes through the kernel. Invoicing calls `lib/approvals.request()`; it never imports reconciliation code.
- `lib/kernel/index.ts` is the single sanctioned kernel surface modules import from.
- A unit test asserts the import graph contains **no upward edges** (kernel → module).
- Module folders each declare `MODULE_KEY`, and register their routes in a central `module-registry.ts` so navigation, RBAC and the "module unavailable" gate have one source of truth.

**Why this keeps the accounting core isolated:** the posting engine must be callable by *any* future module. When Phase 2 Procurement lands, it calls `lib/accounting` exactly the way invoicing does. If the posting engine ever imports an invoice type, it stops being reusable and Phase 2 would require rebuilding the core — precisely the failure PDF §17.17 and §74 forbid.

### 2.3 Ledger invariants (kernel-level, non-negotiable)

- `Decimal(20, 6)` for money. Never `Float`.
- Amounts stored **per currency** plus a **base-currency** value. Base currency TZS.
- A journal entry is postable only if **all** hold:
  1. `sum(debits) == sum(credits)` across its lines,
  2. all lines share one currency (a multi-currency entry is split into per-currency sub-entries with a linked FX-difference entry),
  3. its `FinancialPeriod` is `OPEN` (or `REOPENED` by approved action),
  4. the posting user is **not** the submitting user (segregation of duties),
  5. it has a completed `ApprovalRequest` where the policy requires one,
  6. every line's account is `POSTABLE` and `ACTIVE` or `LOCKED`-but-approved-for-period.
- `JournalEntry` / `JournalLine` are the **only** writer of ledger balances. `Transaction`, `Invoice`, `Payment`, `Transfer`, `Receipt`, `OpeningBalance` are *business documents that generate* journal entries — never the reverse.
- Balances are **derived** from `JournalLine` by query. `AccountBalanceSnapshot` is a rebuildable cache for dashboard speed; it is never authoritative and can be truncated and recomputed at any time.
- Approved/posted records are immutable. A Postgres trigger rejects `UPDATE`/`DELETE` on `journal_entries` when `status IN ('POSTED','LOCKED')`, and on `transactions` when `status IN ('POSTED','LOCKED')` — a **database-level** guarantee that survives a buggy service layer.

### 2.4 API-first

Every mutation is reachable through a Server Action *and* the same underlying service function exposed via `app/api/v1/**`. Service functions take an explicit `RequestContext` (`{ actor, permissions, requestId, idempotencyKey, ip, userAgent, channel }`) so authorization, audit and idempotency **cannot be bypassed** by taking the internal path instead of the API. Versioned at `/api/v1`; API keys / OAuth for future integrations (PDF §59 targets: Iventika, Uzanite, banks, mobile-money providers, email, SMS, cloud storage); a `webhook_outbox` for outbound integration events.

### 2.5 PWA

`manifest.webmanifest` + service worker. Offline capability is an **allowlist**: only `RECEIPT_CAPTURE` (photo + minimum metadata) and non-final `DRAFT_SAVE`. Approval, posting, reversal, period close/reopen and anything touching the ledger require connectivity, refused client-side *and* rejected server-side with a distinct error code. Client-side checks are a UX affordance only; the **server is the enforcement point**. Sync uses client-generated idempotency keys and returns per-item conflict descriptors.

### 2.6 Cross-cutting enforcement map

| Concern | Enforcement point |
|---|---|
| Authorization | `authorize()` inside every service function in `lib/`, never UI-only |
| Audit | Written in the **same database transaction** as the mutation; audit failure rolls back the mutation |
| Idempotency | `IdempotencyKey` table on all financial POST/PATCH/DELETE routes |
| Rate limiting | Strict on auth routes, moderate on sensitive financial routes |
| Immutability | DB trigger guard + service-layer checks + period-lock trigger |
| Multi-tenant isolation | Every table carries `organizationId`; Prisma client extensions inject the filter |
| No direct prod data edits | No production data access outside application procedures; migrations only |

---

## 3. Complete Phase 1 Prisma Schema Draft

> Draft for review. Field names may be refined in Milestone 1, but the model set, enums and invariants below are the intended shape. Presented as a fenced block for readability; it is a design artefact, not committed code.

### 3.1 Enums

```prisma
// ---- Identity & access ----------------------------------------------------

enum UserStatus              { INVITED ACTIVE SUSPENDED DEACTIVATED }
enum MfaMethod               { TOTP WEBAUTHN }   // WEBAUTHN reserved, not built in Phase 1
enum MfaDeviceStatus         { PENDING ACTIVE DISABLED REVOKED }
enum SessionRevokeReason     { LOGOUT TIMEOUT_IDLE TIMEOUT_ABSOLUTE PASSWORD_CHANGED MFA_CHANGED ADMIN_REVOKED SUSPECTED_COMPROMISE }
enum LoginOutcome            { SUCCESS FAILURE_BAD_CREDENTIALS FAILURE_MFA FAILURE_LOCKED FAILURE_INACTIVE FAILURE_EXPIRED_PASSWORD BLOCKED_RATE_LIMIT }
enum PasswordHashAlgorithm   { ARGON2ID BCRYPT }
enum DelegationKind          { APPROVAL_AUTHORITY TEMPORARY_ACCESS ACTING_CAPACITY }

// ---- RBAC (PDF §5) -------------------------------------------------------

enum PermissionAction {
  VIEW CREATE EDIT SUBMIT APPROVE REJECT POST REVERSE EXPORT CONFIGURE ADMINISTER
}

enum ModuleKey {
  DASHBOARD_CEO DASHBOARD_FINANCE USERS_ROLES CHART_OF_ACCOUNTS JOURNAL_ENTRIES
  GENERAL_LEDGER TRIAL_BALANCE TRANSACTIONS APPROVALS PERIODS FINANCIAL_CLOSE
  CASH BANK MOBILE_MONEY PAYMENT_GATEWAYS TREASURY_TRANSFERS STATEMENT_IMPORT
  RECONCILIATION BUDGETS COMMITMENTS CUSTOMERS SUPPLIERS QUOTATIONS INVOICES
  PAYMENTS RECEIPTS CREDIT_NOTES DOCUMENTS MASTER_DATA REPORTS EXPORTS
  AUDIT_TRAIL TAX_COMPLIANCE IMPORTS ANOMALY_DETECTION NOTIFICATIONS SEARCH
  BACKUP_ADMIN API_ADMIN
  // Reserved Phase 2+ keys so permission grants and the "module unavailable"
  // gate can be expressed now without a migration later.
  PROCUREMENT INVENTORY ASSETS FUNDING PROJECTS_FULL CRM
}

enum ScopeDimension   { PROJECT DEPARTMENT COST_CENTRE LOCATION FUNDING_SOURCE ACCOUNT }
enum RoleType          { SYSTEM STANDARD TEMPORARY }
enum AccessReviewStatus { OPEN IN_REVIEW COMPLETED CANCELLED }

// ---- Organisation (PDF §51) ----------------------------------------------

enum OrganizationType  { SINGLE_ENTITY }   // Multi-entity is Phase 4 - flagged, not built
enum RegistrationStatus { NOT_REGISTERED PENDING REGISTERED }  // PDF §2: not yet registered

enum LocationType {
  HEAD_OFFICE OFFICE LAB WAREHOUSE PROJECT_SITE
  UNIVERSITY_FACILITY   // PDF §2: using university facilities with permission
  PERMITTED_USE REMOTE OTHER
}

enum MasterDataStatus  { DRAFT PENDING_APPROVAL ACTIVE REJECTED INACTIVE ARCHIVED }

// ---- Currency (PDF §50) --------------------------------------------------

enum RateSource           { MANUAL IMPORTED PROVIDER }
enum FxDifferenceTreatment { EXPENSE INCOME SUSPENSE }

// ---- Accounting core (PDF §6, §7) ----------------------------------------

enum AccountType     { ASSET LIABILITY EQUITY REVENUE EXPENSE }
enum NormalBalance   { DEBIT CREDIT }

enum AccountSubCategory {
  // Assets
  CASH BANK MOBILE_MONEY RECEIVABLE
  INVENTORY          // reserved for Phase 2 - CoA line mandated by PDF §7
  EQUIPMENT          // reserved for Phase 2 - CoA line mandated by PDF §7
  OTHER_ASSET
  // Liabilities
  SUPPLIER_PAYABLE TAX_PAYABLE LOAN ACCRUED_EXPENSE OTHER_OBLIGATION
  // Equity
  CAPITAL RETAINED_EARNINGS
  FUTURE_INVESTMENT  // reserved - "Future investment/equity accounts", PDF §7
  // Revenue
  REVENUE_TRAINING REVENUE_CONSULTING REVENUE_SOFTWARE REVENUE_SAAS
  REVENUE_AI_SERVICES REVENUE_IOT_SERVICES REVENUE_HARDWARE REVENUE_ELECTRONICS
  REVENUE_COMPONENT_SALES REVENUE_SUBSCRIPTION REVENUE_TOKEN_PACKAGES REVENUE_OTHER
  // Expenses
  EXPENSE_INTERNET EXPENSE_CLOUD EXPENSE_AI_API EXPENSE_TRANSPORT
  EXPENSE_MARKETING EXPENSE_SOFTWARE EXPENSE_WORKSPACE
  EXPENSE_SALARIES  // reserved for Phase 4 payroll
  EXPENSE_TRAINING EXPENSE_HARDWARE_PROTOTYPING EXPENSE_OTHER
  // Control
  CONTROL
}

enum AccountStatus    { ACTIVE INACTIVE LOCKED PENDING_ARCHIVE }
enum JournalEntryType { STANDARD OPENING_BALANCE ADJUSTMENT REVERSAL CORRECTION CLOSING SYSTEM }
enum JournalEntryStatus { DRAFT SUBMITTED APPROVED REJECTED POSTED LOCKED REVERSED VOIDED }
enum JournalSource    { MANUAL TRANSACTION INVOICE PAYMENT RECEIPT TRANSFER OPENING_BALANCE CLOSE REVERSAL IMPORT }

// PDF §8 workflow: Draft -> Submitted -> Approved/Rejected -> Posted/Locked -> Adjusted/Reversed
enum TransactionStatus { DRAFT SUBMITTED APPROVED REJECTED POSTED LOCKED ADJUSTED REVERSED CANCELLED }

// PDF §2 + §52 - historical / imported figures are entered honestly.
enum VerificationStatus { UNVERIFIED PENDING_VERIFICATION VERIFIED DISPUTED SUPERSEDED }

enum PaymentMethod   { CASH BANK_TRANSFER MOBILE_MONEY PAYMENT_GATEWAY CHEQUE CARD OTHER }
enum ReversalType    { FULL_REVERSAL PARTIAL_REVERSAL CORRECTING_ENTRY CANCELLING_ENTRY }

enum ReasonCodeCategory {
  DATA_ENTRY_ERROR DUPLICATE MISCLASSIFICATION WRONG_AMOUNT WRONG_DATE WRONG_PARTY
  CURRENCY_VARIANCE BANK_FEE RETURNED_PAYMENT FX_VARIANCE SUPPLIER_CREDIT
  SYSTEM_CORRECTION PERIOD_MISALLOCATION EARLY_PAYMENT_RECEIVED LATE_PAYMENT
  GOODWILL WRITE_OFF YEAR_END OTHER
}

// ---- Financial periods (PDF §63) ----------------------------------------

enum PeriodType   { MONTHLY QUARTERLY ANNUAL }
enum PeriodStatus { OPEN CLOSING CLOSED LOCKED REOPEN_PENDING REOPENED }

// ---- Treasury (PDF §10) --------------------------------------------------

enum TreasuryAccountKind {
  CASH BANK MOBILE_MONEY PAYMENT_GATEWAY PROJECT_FUND GRANT_FUND OTHER
}  // OTHER = "Future accounts"

enum AccountHolderType    { ORGANIZATION INDIVIDUAL THIRD_PARTY }
enum TransferStatus       { DRAFT SUBMITTED APPROVED PROCESSED FAILED REVERSED CANCELLED }
enum PaymentScheduleStatus { SCHEDULED DUE PARTIALLY_PAID PAID OVERDUE CANCELLED }

// ---- Import & reconciliation (PDF §11, §12) ------------------------------

enum ImportSource { EXCEL CSV API MANUAL }

enum ImportBatchStatus {
  UPLOADED MAPPING VALIDATING PREVIEW AWAITING_APPROVAL APPROVED
  IMPORTING COMPLETED PARTIALLY_COMPLETED FAILED ROLLED_BACK
}

enum ImportErrorType   { VALIDATION DUPLICATE MAPPING PERMISSION SYSTEM PARSE }
enum ReconciliationTarget { BANK CASH MOBILE_MONEY PAYMENT_GATEWAY PROJECT_FUND GRANT_FUND }
enum ReconciliationStatus { NOT_STARTED IN_PROGRESS BALANCED REVIEWED APPROVED REOPENED }

enum ReconciliationLineStatus { UNMATCHED PROPOSED MATCHED PARTIALLY_MATCHED EXCLUDED EXCEPTION }

enum MatchType { EXACT FUZZY_DATE FUZZY_AMOUNT ONE_TO_ONE ONE_TO_MANY MANY_TO_ONE PARTIAL MANUAL }
enum ReconciliationAdjustmentStatus { DRAFT SUBMITTED APPROVED POSTED }

// ---- Budget (PDF §13, §67) -----------------------------------------------

enum BudgetLevel        { COMPANY DEPARTMENT PROJECT FUNDING ACTIVITY }
enum BudgetStatus       { DRAFT SUBMITTED APPROVED ACTIVE REVISED CLOSED EXPIRED REJECTED }
enum BudgetPeriodType   { MONTHLY QUARTERLY ANNUAL }
enum CommitmentStatus   { OPEN PARTIALLY_SETTLED SETTLED CANCELLED EXPIRED OVERDUE }
enum CommitmentSource   { INVOICE PURCHASE_COMMITMENT CONTRACT PAYMENT_SCHEDULE MANUAL }
enum ScenarioKind       { BEST_CASE EXPECTED_CASE WORST_CASE CUSTOM }

// ---- Parties (PDF §15, §17, §21, §23) -----------------------------------

enum PartyType          { INDIVIDUAL COMPANY GOVERNMENT NGO ACADEMIC_INSTITUTION FUNDER OTHER }
enum CustomerStatus     { PROSPECT ACTIVE INACTIVE CREDIT_HOLD BLOCKED }
enum SupplierStatus     { PROSPECT UNDER_REVIEW ACTIVE INACTIVE BLOCKED }
enum PaymentTermsCode   { DUE_ON_RECEIPT NET_7 NET_14 NET_30 NET_45 NET_60 NET_90 CUSTOM }
enum PartyRiskLevel     { LOW MEDIUM HIGH CRITICAL }
enum QuotationStatus    { DRAFT PENDING_APPROVAL APPROVED REJECTED SENT VIEWED ACCEPTED DECLINED EXPIRED CONVERTED_TO_INVOICE CANCELLED }
enum InvoiceStatus      { DRAFT PENDING_APPROVAL APPROVED SENT PARTIALLY_PAID PAID PARTIALLY_CREDIT_NOTED OVERDUE CANCELLED }
enum CreditNoteStatus   { DRAFT PENDING_APPROVAL APPROVED APPLIED ISSUED VOIDED }
enum DebitNoteStatus    { DRAFT PENDING_APPROVAL APPROVED APPLIED ISSUED VOIDED }
enum PaymentDirection   { INBOUND OUTBOUND }
enum PaymentStatus      { DRAFT PENDING_APPROVAL APPROVED IN_PROCESSING COMPLETED FAILED PARTIALLY_REVERSED REVERSED CANCELLED }
enum ReceiptStatus      { DRAFT ISSUED VOIDED CANCELLED }
enum AllocationMethod   { AUTOMATIC FIFO MANUAL }
enum RecurrenceFrequency { NONE DAILY WEEKLY MONTHLY QUARTERLY ANNUALLY CUSTOM }

// ---- Documents (PDF §28) --------------------------------------------------

enum DocumentCategory {
  RECEIPT INVOICE QUOTATION CONTRACT GRANT_DOCUMENT TAX_DOCUMENT
  COMPLIANCE_DOCUMENT FINANCIAL_EVIDENCE
  ASSET_DOCUMENT   // Phase 2 assets - reserved
  SUPPLIER_DOCUMENT CUSTOMER_DOCUMENT BANK_STATEMENT RECONCILIATION_SUPPORT OTHER
}

enum DocumentStatus      { UPLOADED UNDER_REVIEW APPROVED REJECTED EXPIRED ARCHIVED }
enum DocumentVisibility  { PRIVATE RESTRICTED ORGANIZATION }

enum DocumentEntityType {
  TRANSACTION INVOICE PAYMENT RECEIPT QUOTATION SUPPLIER CUSTOMER PROJECT
  FUNDING_SOURCE TAX_OBLIGATION CREDENTIAL PERIOD FINANCIAL_CLOSE BUDGET
  COMMITMENT JOURNAL_ENTRY AUDIT_EVENT ANY
}

enum RetentionAction { ARCHIVE DELETE RETAIN_FOREVER }  // DELETE blocked by legal hold
enum LegalHoldReason { LEGAL_DISPUTE AUDIT REGULATORY INVESTIGATION CONTRACTUAL OTHER }

// ---- Approvals ------------------------------------------------------------

enum ApprovalEntityType {
  TRANSACTION JOURNAL_ENTRY INVOICE PAYMENT RECEIPT QUOTATION CREDIT_NOTE DEBIT_NOTE
  REFUND BUDGET BUDGET_REVISION BUDGET_TRANSFER COMMITMENT
  PERIOD_REOPEN FINANCIAL_CLOSE ADJUSTMENT REVERSAL
  MASTER_DATA_CHANGE
  SUPPLIER_BANK_DETAIL_CHANGE   // PDF §23
  CUSTOMER_CREDIT_LIMIT DOCUMENT IMPORT_BATCH RECONCILIATION
  RECONCILIATION_ADJUSTMENT TAX_FILING
}

enum ApprovalRequestStatus { PENDING IN_PROGRESS APPROVED REJECTED CANCELLED EXPIRED SUPERSEDED }
enum ApprovalStepType      { APPROVAL REVIEW NOTIFICATION SIGN_OFF }  // SIGN_OFF = CEO, PDF §63
enum ApprovalAssigneeType  { ROLE USER USER_DELEGATED SPECIFIC_USER }
enum ApprovalOutcome       { PENDING APPROVED REJECTED }
enum ResolutionMode        { ANY ALL QUORUM }

enum ApprovalConditionOperator {
  ALWAYS AMOUNT_GREATER_THAN AMOUNT_GREATER_OR_EQUAL AMOUNT_LESS_THAN
  AMOUNT_BETWEEN PERCENT_OF_BUDGET OVER_BUDGET NEW_COUNTERPARTY
  SUPPLIER_BANK_DETAIL_CHANGED FUNDING_RESTRICTED CROSS_PROJECT
  CURRENCY_NOT_BASE MANUAL_FLAG
}

enum ApprovalDecision { APPROVED REJECTED DEFERRED RETURNED_FOR_CHANGES SKIPPED CANCELLED }

// ---- Audit (PDF §54) ------------------------------------------------------

enum AuditAction {
  // PDF §54 enumerated list, first
  LOGIN LOGOUT
  TRANSACTION_CREATED TRANSACTION_UPDATED
  APPROVAL REJECTION REVERSAL
  DOCUMENT_UPLOADED DOCUMENT_DOWNLOADED
  USER_CHANGES PERMISSION_CHANGES
  EXPORT CONFIGURATION_CHANGES PERIOD_REOPENING INTEGRATION_ACTIVITY SECURITY_EVENT
  // Expanded for real traceability
  LOGIN_FAILED SESSION_REVOKED PASSWORD_CHANGED PASSWORD_RESET_REQUESTED
  PASSWORD_RESET_COMPLETED MFA_ENROLLED MFA_VERIFIED MFA_DISABLED
  USER_CREATED USER_UPDATED USER_ACTIVATED USER_DEACTIVATED USER_SUSPENDED
  ROLE_ASSIGNED ROLE_REMOVED PERMISSION_GRANTED PERMISSION_REVOKED
  DELEGATION_GRANTED DELEGATION_REVOKED ACCESS_REVIEW_COMPLETED
  TRANSACTION_SUBMITTED TRANSACTION_APPROVED TRANSACTION_REJECTED
  TRANSACTION_POSTED TRANSACTION_LOCKED TRANSACTION_REVERSED TRANSACTION_ADJUSTED
  JOURNAL_ENTRY_CREATED JOURNAL_ENTRY_POSTED JOURNAL_ENTRY_REVERSED
  ACCOUNT_CREATED ACCOUNT_UPDATED ACCOUNT_LOCKED
  PERIOD_OPENED PERIOD_CLOSED PERIOD_LOCKED PERIOD_REOPEN_REQUESTED PERIOD_REOPENED
  PERIOD_SIGN_OFF CLOSE_COMPLETED
  DOCUMENT_VERSION_CREATED DOCUMENT_DELETED DOCUMENT_LEGAL_HOLD_SET
  DOCUMENT_LEGAL_HOLD_RELEASED MASTER_DATA_CHANGED
  SUPPLIER_BANK_DETAIL_CHANGE_REQUESTED SUPPLIER_BANK_DETAIL_CHANGE_APPROVED
  RECONCILIATION_MATCH_CREATED RECONCILIATION_EXCEPTION_RESOLVED
  RECONCILIATION_APPROVED RECONCILIATION_ADJUSTMENT_POSTED
  IMPORT_UPLOADED IMPORT_MAPPING_SAVED IMPORT_VALIDATED IMPORT_APPROVED
  IMPORT_EXECUTED IMPORT_ROLLED_BACK
  BUDGET_CREATED BUDGET_REVISION_APPROVED BUDGET_TRANSFER_APPROVED
  COMMITMENT_CREATED COMMITMENT_SETTLED
  INVOICE_ISSUED INVOICE_CANCELLED PAYMENT_COMPLETED PAYMENT_REVERSED
  RECEIPT_ISSUED CREDIT_NOTE_ISSUED REPORT_GENERATED EXPORT_DOWNLOADED
  TAX_RULE_CHANGED EXCHANGE_RATE_CHANGED
  ANOMALY_FLAG_RAISED ANOMALY_FLAG_ACKNOWLEDGED ANOMALY_FLAG_DISMISSED
  RATE_LIMIT_TRIPPED ACCESS_DENIED API_KEY_CREATED API_KEY_REVOKED WEBHOOK_SENT
  BACKUP_VERIFIED RESTORE_TEST DATA_EXPORT_BULK RETENTION_APPLIED
}

enum AuditEntityType {
  USER ROLE PERMISSION SESSION TRANSACTION JOURNAL_ENTRY JOURNAL_LINE ACCOUNT
  PERIOD CLOSE DOCUMENT DOCUMENT_VERSION IMPORT_BATCH IMPORT_ROW RECONCILIATION
  RECONCILIATION_MATCH BUDGET BUDGET_REVISION BUDGET_TRANSFER COMMITMENT
  CUSTOMER SUPPLIER QUOTATION INVOICE PAYMENT RECEIPT CREDIT_NOTE DEBIT_NOTE
  PRODUCT_SERVICE PROJECT DEPARTMENT LOCATION COST_CENTRE FUNDING_SOURCE
  EXCHANGE_RATE TAX_RULE TAX_OBLIGATION CREDENTIAL APPROVAL_REQUEST
  APPROVAL_STEP NOTIFICATION ANOMALY_FLAG API_KEY WEBHOOK BACKUP_RUN SYSTEM
}

enum AuditResult { SUCCESS FAILURE DENIED PARTIAL }
enum SecurityEventSeverity { INFO LOW MEDIUM HIGH CRITICAL }

enum SecurityEventType {
  BRUTE_FORCE_ATTEMPT CREDENTIAL_STUFFING_PATTERN IMPOSSIBLE_TRAVEL
  NEW_DEVICE_LOGIN NEW_COUNTRY_LOGIN PRIVILEGE_ESCALATION_ATTEMPT
  SOD_VIOLATION_ATTEMPT PERMISSION_DENIED_SPIKE SUSPICIOUS_EXPORT_VOLUME
  SUPPLIER_DETAIL_CHANGED_THEN_PAID   // PDF §23 fraud pattern
  OFFLINE_QUEUE_REPLAY_ATTEMPT IDEMPOTENCY_CONFLICT MALFORMED_UPLOAD
  VELOCITY_ANOMALY TIME_ANOMALY CONFIG_CHANGED_OUT_OF_BAND
}

// ---- Notifications (PDF §46) ---------------------------------------------

enum NotificationChannel { IN_APP EMAIL SMS PUSH }
// Phase 1 delivery = IN_APP + EMAIL minimum (BUILD_PROMPT §5). SMS architected only.
enum NotificationStatus { PENDING SENT DELIVERED FAILED READ ARCHIVED SUPPRESSED }
enum NotificationCategory {
  APPROVAL BUDGET_ALERT PAYMENT_REMINDER COMPLIANCE_ALERT SECURITY_ALERT
  DOCUMENT_EXPIRY PERIOD_CLOSE RECONCILIATION STATEMENT_IMPORT OVER_BUDGET
  ANOMALY SYSTEM REPORT_READY
}
enum NotificationSeverity { INFO SUCCESS WARNING CRITICAL }

// ---- Tax & compliance (PDF §32, §42) -------------------------------------

enum TaxRuleType { VAT WITHHOLDING INCOME_TAX TURNOVER_TAX FILING_FEE STAMP_DUTY OTHER }
enum TaxCalculationBasis { EXCLUSIVE INCLUSIVE NOT_APPLICABLE }
enum TaxObligationStatus { NOT_APPLICABLE PENDING FILED PAID OVERDUE EXEMPT }  // NOT_APPLICABLE = pre-registration, PDF §2
enum TaxObligationPeriod { MONTHLY QUARTERLY ANNUAL ONE_OFF }
enum TaxDirection { OUTPUT INPUT WITHHELD PAYABLE }

enum CredentialType {
  REGISTRATION TIN_CERTIFICATE LICENCE PERMIT CERTIFICATION MEMBERSHIP
  DOMAIN INSURANCE SOFTWARE_SUBSCRIPTION OTHER
}
enum CredentialStatus { PENDING ACTIVE EXPIRING_SOON EXPIRED REVOKED NOT_APPLICABLE }

// ---- Anomaly detection (PDF §30, §65) - flag only ------------------------

enum AnomalyType {
  DUPLICATE_TRANSACTION DUPLICATE_INVOICE UNUSUAL_SPENDING
  UNUSUAL_LOGIN_ACTIVITY SUSPICIOUS_PAYMENT_CHANGE SOD_VIOLATION
  UNUSUAL_TRANSACTION_PATTERN BUDGET_ABUSE UNEXPECTED_PARTY_CHANGE
  ROUNDING_PATTERN WEEKEND_TRANSACTION AMOUNT_OUTLIER LATE_NIGHT_ACTIVITY
}
enum AnomalySeverity { LOW MEDIUM HIGH CRITICAL }
enum AnomalyStatus    { OPEN ACKNOWLEDGED DISMISSED CONFIRMED RESOLVED }
// NOTE: deliberately NO `accusedUserId` on this model. PDF §65 - AI "shall not
// independently accuse a person". The subject is the record, not a person.

// ---- Financial close (PDF §64) -------------------------------------------

enum CloseItemStatus { NOT_STARTED IN_PROGRESS PASSED FAILED WAIVED NOT_APPLICABLE }
enum CloseItemKey {
  BANK_RECONCILIATION CASH_RECONCILIATION RECEIVABLES PAYABLES MISSING_DOCUMENTS
  UNAPPROVED_TRANSACTIONS BUDGET_VARIANCES ADJUSTMENTS FINANCIAL_STATEMENTS
  OPEN_ITEMS_DISCLOSED GO_LIVE_CLEANUP
}

// ---- Infrastructure -------------------------------------------------------

enum BackupType   { FULL INCREMENTAL POINT_IN_TIME }
enum BackupStatus { SCHEDULED RUNNING SUCCEEDED FAILED VERIFIED VERIFICATION_FAILED EXPIRED }
enum ApiKeyStatus { ACTIVE EXPIRED REVOKED }
enum WebhookStatus { PENDING DELIVERED FAILED DEAD_LETTER }

// ---- PWA sync (PDF §58) --------------------------------------------------

enum SyncActionType {
  RECEIPT_CAPTURE  // offline-allowed
  DRAFT_SAVE       // offline-allowed
  CONTACT_CARD_SAVE// offline-allowed, non-financial
  // Everything below MUST be online-only.
  SUBMIT APPROVE REJECT POST REVERSE PERIOD_CLOSE PERIOD_REOPEN
}
enum SyncStatus { QUEUED SYNCING SYNCED CONFLICT FAILED DISCARDED }
```

### 3.2 Models — Identity, access, organisation

```prisma
// ===========================================================================
// B1. IDENTITY, ACCESS & AUTHENTICATION  (PDF §4, §5)
// ===========================================================================

model User {
  id                    String          @id @default(cuid())
  email                 String
  emailNormalized       String          @unique
  fullName              String
  jobTitle              String?
  phone                 String?
  avatarUrl             String?

  status                UserStatus      @default(INVITED)
  isActive              Boolean         @default(true)
  deactivatedAt         DateTime?
  deactivationReason    String?

  // Credentials (PDF §4 strong passwords)
  passwordHash          String?
  passwordAlgorithm     PasswordHashAlgorithm?
  passwordChangedAt     DateTime?
  mustChangePassword    Boolean         @default(false)
  failedLoginCount      Int             @default(0)
  lockedUntil           DateTime?
  lastLoginAt           DateTime?
  emailVerifiedAt       DateTime?
  passwordResetToken    String?         @unique
  passwordResetExpiresAt DateTime?

  // MFA (PDF §4). MFA enforced for CEO + Finance Officer (BUILD_PROMPT §7)
  mfaEnforced           Boolean         @default(false)
  mfaVerifiedAt         DateTime?

  // Organisation context
  primaryLocationId     String?
  primaryLocation       Location?       @relation("UserPrimaryLocation", fields: [primaryLocationId], references: [id])
  homeDepartmentId      String?
  homeDepartment        Department?     @relation("UserHomeDepartment", fields: [homeDepartmentId], references: [id])

  // Privacy (PDF §56)
  dataClassification    String          @default("INTERNAL")
  retentionReviewAt     DateTime?

  createdById String?
  createdBy   User?   @relation("UserCreatedBy",  fields: [createdById], references: [id])
  createdAt   DateTime @default(now())
  updatedById String?
  updatedBy   User?   @relation("UserUpdatedBy",  fields: [updatedById], references: [id])
  updatedAt   DateTime @updatedAt
  deletedAt   DateTime?      // soft delete; financial references preserved

  sessions         Session[]
  loginHistory     LoginHistory[]
  mfaDevices       MfaDevice[]
  userRoles        UserRole[]
  delegationsGranted   Delegation[] @relation("DelegationGrantor")
  delegationsReceived Delegation[] @relation("DelegationGrantee")
  accessReviewItems   AccessReviewItem[]

  @@index([status, isActive])
  @@index([homeDepartmentId])
  @@index([primaryLocationId])
  @@map("users")
}

model MfaDevice {
  id                String           @id @default(cuid())
  userId            String
  user              User             @relation(fields: [userId], references: [id], onDelete: Cascade)
  method            MfaMethod        @default(TOTP)
  label             String
  secretEnc         String           // encrypted at rest - never store plaintext TOTP secret
  recoveryCodesEnc  String?
  status            MfaDeviceStatus  @default(PENDING)
  confirmedAt       DateTime?
  lastUsedAt        DateTime?
  failedAttempts    Int              @default(0)
  lockedUntil       DateTime?
  createdAt         DateTime         @default(now())
  updatedAt         DateTime         @updatedAt

  @@index([userId, status])
  @@map("mfa_devices")
}

model Session {
  id                 String             @id @default(cuid())
  sessionToken       String             @unique
  userId             String
  user               User               @relation(fields: [userId], references: [id], onDelete: Cascade)
  // Device / session monitoring (PDF §4)
  ipAddress          String?
  userAgent          String?
  deviceFingerprint  String?
  deviceLabel        String?
  createdAt          DateTime           @default(now())
  lastActiveAt       DateTime           @default(now())
  idleTimeoutAt      DateTime?
  absoluteExpiresAt  DateTime
  revokedAt          DateTime?
  revokedReason      SessionRevokeReason?
  mfaSatisfiedAt     DateTime?

  @@index([userId, lastActiveAt])
  @@index([deviceFingerprint])
  @@index([absoluteExpiresAt])
  @@map("sessions")
}

model LoginHistory {
  id                String        @id @default(cuid())
  userId            String?
  user              User?         @relation(fields: [userId], references: [id], onDelete: SetNull)
  emailAttempted    String
  outcome           LoginOutcome
  ipAddress         String?
  userAgent         String?
  deviceFingerprint String?
  geoInfo           String?
  mfaAttempted      Boolean       @default(false)
  failureReason     String?
  sessionId         String?
  occurredAt        DateTime      @default(now())

  @@index([userId, occurredAt])
  @@index([emailAttempted, occurredAt])
  @@index([outcome, occurredAt])
  @@map("login_history")
}

// Rate limiting / lockout / password strength are CONFIGURATION, not code.
model AuthPolicy {
  id                          String   @id @default(cuid())
  name                        String   @unique
  maxFailedAttempts          Int      @default(5)
  lockoutDurationMinutes     Int      @default(15)
  rateLimitWindowSeconds     Int      @default(60)
  maxAttemptsPerWindow       Int      @default(10)
  ipRateLimitPerMinute       Int      @default(20)
  sessionIdleTimeoutMinutes  Int      @default(30)
  sessionAbsoluteTimeoutHours Int     @default(12)
  passwordMinLength          Int      @default(12)
  passwordRequireUppercase   Boolean  @default(true)
  passwordRequireLowercase   Boolean  @default(true)
  passwordRequireNumber      Boolean  @default(true)
  passwordRequireSymbol      Boolean  @default(true)
  mfaRequiredRoleCodes       String[] @default([])
  isActive                   Boolean  @default(true)
  createdAt                  DateTime @default(now())
  updatedAt                  DateTime @updatedAt

  @@map("auth_policies")
}

// ---- RBAC (PDF §5: configurable by role / module / action / dimension) ----

model Role {
  id            String     @id @default(cuid())
  code          String     @unique
  name          String
  description   String?
  type          RoleType   @default(STANDARD)
  isSystem      Boolean    @default(false)
  isActive      Boolean    @default(true)

  // Flags read by the authorization layer
  isFinalApprover   Boolean  @default(false) // CEO final authority (PDF §3.1)
  canBypassApproval Boolean  @default(false) // ALWAYS false in Phase 1
  maxApprovalAmount Decimal? @db.Decimal(20,6)
  approvalCurrency  String?  @db.Char(3)

  createdById String?
  createdAt   DateTime @default(now())
  updatedById String?
  updatedAt   DateTime @updatedAt

  rolePermissions  RolePermission[]
  userRoles        UserRole[]
  scopeGrants      RoleScopeGrant[]
  approvalPolicies ApprovalPolicy[]
  policySteps      ApprovalPolicyStep[]

  @@index([isSystem, isActive])
  @@map("roles")
}

model Permission {
  id          String           @id @default(cuid())
  module      ModuleKey
  action      PermissionAction
  resource    String?          // optional sub-resource, e.g. "supplier.bank_details"
  description String?
  // PDF §5 "Sensitive actions shall require additional authorization where appropriate"
  requiresStepUpAuth Boolean  @default(false)

  roles RolePermission[]

  @@unique([module, action, resource])
  @@index([module])
  @@map("permissions")
}

model RolePermission {
  roleId       String
  role         Role       @relation(fields: [roleId], references: [id], onDelete: Cascade)
  permissionId String
  permission   Permission @relation(fields: [permissionId], references: [id], onDelete: Cascade)
  conditions   Json?      // extra constraints attached to this specific grant

  @@id([roleId, permissionId])
  @@index([permissionId])
  @@map("role_permissions")
}

model UserRole {
  id          String    @id @default(cuid())
  userId      String
  user        User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  roleId      String
  role        Role      @relation(fields: [roleId], references: [id], onDelete: Cascade)
  isTemporary Boolean   @default(false)   // PDF §4 temporary access
  startsAt    DateTime  @default(now())
  expiresAt   DateTime?                    // auto-expiry (PDF §4)
  grantedById String?
  grantedAt   DateTime  @default(now())
  revokedAt   DateTime?
  reason      String?

  @@index([userId])
  @@index([roleId])
  @@index([expiresAt])
  @@map("user_roles")
}

// Dimension-scoped grants (PDF §5). dimensionValueId = null => all values.
model RoleScopeGrant {
  id               String           @id @default(cuid())
  roleId           String
  role             Role             @relation(fields: [roleId], references: [id], onDelete: Cascade)
  permissionId     String?
  dimension        ScopeDimension
  dimensionValueId String?
  includeChildren  Boolean          @default(false)
  effect           String           @default("ALLOW")   // DENY wins over ALLOW

  createdAt DateTime @default(now())

  @@index([roleId, dimension])
  @@index([dimension, dimensionValueId])
  @@map("role_scope_grants")
}

model Delegation {
  id               String         @id @default(cuid())
  grantorId        String
  grantor          User           @relation("DelegationGrantor", fields: [grantorId], references: [id], onDelete: Cascade)
  granteeId        String
  grantee          User           @relation("DelegationGrantee", fields: [granteeId], references: [id], onDelete: Cascade)
  kind             DelegationKind
  roleId           String?
  role             Role?          @relation(fields: [roleId], references: [id])
  scope            Json?          // dimension limits, amount ceilings, entity limits
  reason           String
  startsAt         DateTime
  expiresAt        DateTime       // MANDATORY - automatic expiry (PDF §4)
  revokedAt        DateTime?
  revokedById      String?
  revocationReason String?
  createdAt        DateTime       @default(now())

  @@index([granteeId, expiresAt])
  @@index([grantorId])
  @@index([roleId])
  @@map("delegations")
}

model AccessReview {
  id            String             @id @default(cuid())
  name          String
  periodStart   DateTime
  periodEnd     DateTime
  status        AccessReviewStatus @default(OPEN)
  scopeJson     Json?
  initiatedById String
  completedAt   DateTime?
  summary       String?
  createdAt     DateTime           @default(now())
  updatedAt     DateTime           @updatedAt

  items AccessReviewItem[]

  @@index([status])
  @@map("access_reviews")
}

model AccessReviewItem {
  id               String       @id @default(cuid())
  reviewId         String
  review           AccessReview @relation(fields: [reviewId], references: [id], onDelete: Cascade)
  userId           String
  user             User         @relation(fields: [userId], references: [id], onDelete: Cascade)
  roleId           String
  currentExpiresAt DateTime?
  decision         String?      // RETAIN | REVOKE | MODIFY
  decisionReason   String?
  decidedById      String?
  decidedAt        DateTime?
  actionedAt       DateTime?

  @@unique([reviewId, userId, roleId])
  @@index([userId])
  @@map("access_review_items")
}

// ===========================================================================
// B2. ORGANISATION, DIMENSIONS & MASTER DATA  (PDF §51, §62)
// ===========================================================================

model Organization {
  id                     String             @id @default(cuid())
  code                   String             @unique
  name                   String
  legalName              String?
  type                   OrganizationType   @default(SINGLE_ENTITY)
  // PDF §2: BLECA is not yet officially registered.
  registrationStatus     RegistrationStatus @default(NOT_REGISTERED)
  registrationNumber     String?
  tin                    String?           // nullable until registered - NEVER hardcoded
  baseCurrency           String             @default("TZS") @db.Char(3)
  fiscalYearStartMonth   Int                @default(1)
  fiscalYearEndDay       Int                @default(31)
  taxJurisdictions       Json?              // PDF §32 - config, not code
  defaultLocationId      String?
  isActive               Boolean            @default(true)
  settings               Json?
  createdAt              DateTime @default(now())
  updatedAt              DateTime @updatedAt

  locations      Location[]
  departments    Department[]
  costCentres    CostCentre[]
  projects       Project[]
  fundingSources FundingSource[]
  currencies     Currency[]

  @@index([registrationStatus])
  @@map("organizations")
}

model Location {
  id                 String       @id @default(cuid())
  organizationId     String
  organization       Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  code               String
  name               String
  type               LocationType
  isOwned            Boolean      @default(false)
  permissionReference String?     // PDF §2: university usage permission
  parentId           String?      // region -> city -> site hierarchy
  parent             Location?    @relation("LocationHierarchy", fields: [parentId], references: [id])
  children           Location[]   @relation("LocationHierarchy")
  address            Json?
  timezone           String       @default("Africa/Dar_es_Salaam")
  isActive           Boolean      @default(true)
  effectiveFrom      DateTime?
  effectiveTo        DateTime?
  createdAt          DateTime     @default(now())
  updatedAt          DateTime     @updatedAt

  users            User[]             @relation("UserPrimaryLocation")
  transactions     Transaction[]
  journalLines     JournalLine[]
  budgets          Budget[]
  customers        Customer[]
  suppliers        Supplier[]
  accounts         TreasuryAccount[]

  @@unique([organizationId, code])
  @@index([type, isActive])
  @@index([parentId])
  @@map("locations")
}

model Department {
  id             String       @id @default(cuid())
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  code           String
  name           String
  parentId       String?
  parent         Department?  @relation("DepartmentHierarchy", fields: [parentId], references: [id])
  children       Department[] @relation("DepartmentHierarchy")
  isActive       Boolean      @default(true)
  createdAt      DateTime     @default(now())
  updatedAt      DateTime     @updatedAt

  users        User[]           @relation("UserHomeDepartment")
  transactions Transaction[]
  journalLines JournalLine[]
  budgets      Budget[]
  costCentres  CostCentre[]

  @@unique([organizationId, code])
  @@index([parentId])
  @@map("departments")
}

model CostCentre {
  id             String       @id @default(cuid())
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  departmentId   String?
  department     Department?  @relation(fields: [departmentId], references: [id])
  code           String
  name           String
  description    String?
  isActive       Boolean      @default(true)
  createdAt      DateTime     @default(now())
  updatedAt      DateTime     @updatedAt

  transactions Transaction[]
  journalLines JournalLine[]
  budgets      Budget[]

  @@unique([organizationId, code])
  @@index([departmentId])
  @@map("cost_centres")
}

model Project {
  // LIGHTWEIGHT dimension in Phase 1 (BUILD_PROMPT §5/§6).
  // Full project management is Phase 2 - see Open Question Q4.
  id             String          @id @default(cuid())
  organizationId String
  organization   Organization    @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  code           String
  name           String
  description    String?
  ownerUserId    String?
  status         String          @default("ACTIVE") // ACTIVE|PLANNED|ON_HOLD|COMPLETED|CANCELLED
  startDate      DateTime?
  endDate        DateTime?
  isActive       Boolean         @default(true)
  createdAt      DateTime        @default(now())
  updatedAt      DateTime        @updatedAt

  transactions Transaction[]
  journalLines JournalLine[]
  budgets      Budget[]
  customers    Customer[]
  invoices     Invoice[]
  accounts     TreasuryAccount[]
  documentLinks DocumentLink[]

  @@unique([organizationId, code])
  @@index([status])
  @@index([ownerUserId])
  @@map("projects")
}

model FundingSource {
  // Dimension in Phase 1. Full funding lifecycle is Phase 2, but restriction
  // semantics are needed NOW for budgets/transactions (PDF §2, §13).
  id               String          @id @default(cuid())
  organizationId   String
  organization     Organization    @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  code             String
  name             String
  funderName       String?
  type             String          // GRANT|COMPETITION|SPONSORSHIP|PARTNERSHIP|
                                   // ACCELERATOR|LOAN|EQUITY|DONATION|INTERNAL|OTHER
  currency         String          @db.Char(3)
  totalAmount      Decimal?        @db.Decimal(20,6)
  isRestricted     Boolean         @default(false)
  restrictionNotes String?
  startDate        DateTime?
  endDate          DateTime?
  status           MasterDataStatus @default(ACTIVE)
  isActive         Boolean         @default(true)
  createdAt        DateTime        @default(now())
  updatedAt        DateTime        @updatedAt

  transactions Transaction[]
  journalLines JournalLine[]
  budgets      Budget[]
  accounts     TreasuryAccount[]

  @@unique([organizationId, code])
  @@index([type, isRestricted])
  @@map("funding_sources")
}

model Currency {
  id             String       @id @default(cuid())
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  code           String       @db.Char(3)
  name           String
  symbol         String?
  minorUnit      Int          @default(2)
  isBase         Boolean      @default(false)
  isActive       Boolean      @default(true)
  roundingMode   String       @default("HALF_UP")   // config, never hardcoded per currency
  createdAt      DateTime     @default(now())
  updatedAt      DateTime     @updatedAt

  exchangeRatesBase  ExchangeRate[] @relation("RateBaseCurrency")
  transactions       Transaction[]
  payments           Payment[]
  invoices           Invoice[]
  budgets            Budget[]

  @@unique([organizationId, code])
  @@map("currencies")
}

model ExchangeRate {
  id            String     @id @default(cuid())
  baseCurrency  String     @db.Char(3)
  baseCurrencyRef Currency? @relation("RateBaseCurrency", fields: [baseCurrencyRef], references: [code])
  quoteCurrency String     @db.Char(3)
  rateDate      DateTime   @db.Date
  rate          Decimal    @db.Decimal(20,10)
  inverseRate   Decimal?   @db.Decimal(20,10)
  source        RateSource @default(MANUAL)
  sourceRef     String?
  isActive      Boolean    @default(true)
  createdById   String?
  createdAt     DateTime   @default(now())
  updatedById   String?
  updatedAt     DateTime   @updatedAt

  @@unique([baseCurrency, quoteCurrency, rateDate])
  @@index([baseCurrency, quoteCurrency, rateDate])
  @@index([rateDate])
  @@map("exchange_rates")
}

// ---- Master data versioning (PDF §62) ------------------------------------

model MasterDataChangeRequest {
  id               String          @id @default(cuid())
  entityType       AuditEntityType
  entityId         String
  entityLabel      String?
  changesJson      Json            // field -> { oldValue, newValue }
  effectiveDate    DateTime
  reason           String
  status           String          @default("PENDING") // PENDING|APPROVED|REJECTED|APPLIED
  requestedById    String
  requestedAt      DateTime        @default(now())
  decidedById      String?
  decidedAt        DateTime?
  decisionReason   String?
  appliedAt        DateTime?
  approvalRequestId String?
  createdAt        DateTime        @default(now())

  versions MasterDataVersion[]

  @@index([entityType, entityId])
  @@index([status])
  @@map("master_data_change_requests")
}

model MasterDataVersion {
  id              String                 @id @default(cuid())
  entityType      AuditEntityType
  entityId        String
  version         Int
  snapshot        Json
  changeRequestId String?
  changeRequest   MasterDataChangeRequest? @relation(fields: [changeRequestId], references: [id])
  effectiveDate   DateTime
  reason          String?
  changedById     String
  changedAt       DateTime               @default(now())

  @@unique([entityType, entityId, version])
  @@index([entityType, entityId, changedAt])
  @@map("master_data_versions")
}

// ---- Lightweight catalogue (PDF §14, §18) --------------------------------

model ProductService {
  // Needed in Phase 1 for quotation/invoice/revenue linkage.
  // Pricing & unit economics (PDF §19) and subscriptions (PDF §20) are Phase 2.
  id             String          @id @default(cuid())
  organizationId String
  code           String
  name           String
  description    String?
  category       String          // TRAINING|CONSULTING|SOFTWARE|SAAS|AI|IOT|HARDWARE|
                                 // ELECTRONICS|COMPONENT|SUBSCRIPTION|TOKEN_PACKAGE|OTHER
  standardCost   Decimal?        @db.Decimal(20,6)
  standardPrice  Decimal?        @db.Decimal(20,6)
  currency       String          @default("TZS") @db.Char(3)
  unit           String?
  taxRuleId      String?
  taxRule        TaxRule?        @relation(fields: [taxRuleId], references: [id])
  isActive       Boolean         @default(true)
  status         MasterDataStatus @default(ACTIVE)
  effectiveFrom  DateTime?
  effectiveTo    DateTime?
  createdById    String?
  createdAt      DateTime        @default(now())
  updatedById    String?
  updatedAt      DateTime        @updatedAt

  quotationLines QuotationLine[]
  invoiceLines   InvoiceLine[]
  receiptLines   ReceiptLine[]

  @@unique([organizationId, code])
  @@index([category, isActive])
  @@map("products_services")
}
```

### 3.3 Models — Chart of Accounts, double-entry core, transactions

```prisma
// ===========================================================================
// B3. CHART OF ACCOUNTS  (PDF §6, §7)
// ===========================================================================

model Account {
  id             String            @id @default(cuid())
  organizationId String
  code           String
  name           String
  type           AccountType
  subCategory    AccountSubCategory
  normalBalance  NormalBalance
  parentId       String?
  parent         Account?          @relation("AccountHierarchy", fields: [parentId], references: [id])
  children       Account[]         @relation("AccountHierarchy")
  level          Int               @default(1)
  // PDF §7 mandates seeding Inventory/Equipment/other lines for FUTURE modules.
  isSystemSeeded Boolean           @default(false)
  isPostable     Boolean           @default(true)
  currency       String            @default("TZS") @db.Char(3)
  status         AccountStatus     @default(ACTIVE)
  isSystem      Boolean           @default(false)   // control/system accounts
  description    String?
  tags           String[]
  isCashEquivalent Boolean         @default(false)
  isBankAccount  Boolean           @default(false)
  isReconcilable Boolean           @default(false)
  requiresDocument Boolean         @default(false)   // evidence requirement
  // PDF §7: "The final Chart of Accounts shall be validated by a qualified accountant"
  validatedByQualifiedAccountant Boolean          @default(false)
  validationDate DateTime?
  validatorNotes String?
  createdById    String?
  createdAt      DateTime          @default(now())
  updatedById    String?
  updatedBy      User?             @relation("AccountUpdatedBy", fields: [updatedById], references: [id])
  updatedAt      DateTime          @updatedAt
  archivedAt     DateTime?

  journalLines       JournalLine[]
  transactions       Transaction[]
  budgets            BudgetLine[]
  commitments        Commitment[]
  treasuryAccounts   TreasuryAccount[]
  paymentAllocations PaymentAllocation[]
  openingBalances    OpeningBalance[]
  closingSnapshots   AccountBalanceSnapshot[]
  taxRules           TaxRule[]

  @@unique([organizationId, code])
  @@index([type, status])
  @@index([parentId])
  @@index([subCategory])
  @@map("accounts")
}

// ===========================================================================
// B4. DOUBLE-ENTRY CORE + FINANCIAL PERIODS  (PDF §6, §8, §9, §63)
// ===========================================================================

model FinancialPeriod {
  id             String       @id @default(cuid())
  organizationId String
  code           String        // e.g. 2026-01, 2026-Q1, FY2026
  name           String
  type           PeriodType
  startDate      DateTime      @db.Date
  endDate        DateTime      @db.Date
  status         PeriodStatus  @default(OPEN)
  isAdjustment   Boolean       @default(false)          // PDF §63 adjustment periods
  allowsBackdatedEntries Boolean @default(false)

  // ---- Period-lock fields (explicit) ----
  closedAt            DateTime?
  closedById          String?
  lockedAt            DateTime?
  lockedById          String?
  reopenRequestedAt   DateTime?
  reopenRequestedById String?
  reopenReason        String?
  reopenApprovedAt    DateTime?
  reopenApprovedById  String?
  reopenedAt          DateTime?
  reopenedById        String?
  reopenCount         Int          @default(0)          // audited reopen counter

  // Year-end (PDF §63)
  isYearEnd              Boolean  @default(false)
  yearEndCompletedAt     DateTime?
  closingBalancesPosted Boolean  @default(false)

  // CEO sign-off (PDF §63, §64)
  signOffAt    DateTime?
  signOffById  String?
  signOffNotes String?

  parentId   String?
  parent     FinancialPeriod?  @relation("PeriodHierarchy", fields: [parentId], references: [id])
  children   FinancialPeriod[] @relation("PeriodHierarchy")
  createdAt  DateTime          @default(now())
  updatedAt  DateTime          @updatedAt

  journalEntries        JournalEntry[]
  transactions          Transaction[]
  openingBalances       OpeningBalance[]
  budgets               Budget[]
  closeChecklistItems   CloseChecklistItem[]
  closeSessions         FinancialClose[]
  reconciliationSessions ReconciliationSession[]

  @@unique([organizationId, code])
  @@index([status])
  @@index([startDate, endDate])
  @@map("financial_periods")
}

model JournalEntry {
  id             String              @id @default(cuid())
  organizationId String
  entryNumber    String              // sequential, gap-checked
  entryDate      DateTime            @db.Date
  periodId       String
  period         FinancialPeriod     @relation(fields: [periodId], references: [id])
  type           JournalEntryType    @default(STANDARD)
  status         JournalEntryStatus  @default(DRAFT)
  source         JournalSource       @default(MANUAL)
  description    String
  narration      String?
  reference      String?
  currency       String              @db.Char(3)   // all lines share one currency
  totalDebit     Decimal             @default(0) @db.Decimal(20,6)
  totalCredit    Decimal             @default(0) @db.Decimal(20,6)
  isBalanced     Boolean             @default(false)

  // Corrections & reversals (PDF §9 - original must remain visible)
  reversesEntryId    String?
  reversesEntry      JournalEntry?  @relation("JournalReversal", fields: [reversesEntryId], references: [id])
  reversedByEntryId  String?
  reversedByEntry    JournalEntry?  @relation("JournalReversal")
  isReversal         Boolean        @default(false)
  reversalType       ReversalType?
  reversalAmount     Decimal?       @db.Decimal(20,6)
  correctionOfId     String?
  correctionOf       JournalEntry?  @relation("JournalCorrection", fields: [correctionOfId], references: [id])
  correctedById      String?
  correctedBy        JournalEntry?  @relation("JournalCorrection")
  isAdjustment       Boolean        @default(false)
  reasonCodeId       String?
  reasonCode         ReasonCode?     @relation(fields: [reasonCodeId], references: [id])
  correctionNotes    String?

  // FX (PDF §50)
  baseCurrencyAmount  Decimal?       @db.Decimal(20,6)
  exchangeRateId      String?
  exchangeRate        ExchangeRate?  @relation(fields: [exchangeRateId], references: [id])
  fxDifferenceAmount  Decimal?       @db.Decimal(20,6)
  fxDifferenceTreatment FxDifferenceTreatment?

  // Provenance (PDF §52)
  importBatchId String?
  importBatch   ImportBatch?    @relation(fields: [importBatchId], references: [id])
  sourceRowRef  String?

  // Approval
  approvalRequestId String?
  approvalRequest   ApprovalRequest? @relation(fields: [approvalRequestId], references: [id])
  submittedById  String?
  submittedAt    DateTime?
  approvedById   String?
  approvedAt     DateTime?
  postedById     String?
  postedAt       DateTime?
  lockedAt       DateTime?
  lockedById     String?
  voidReason     String?
  voidedById     String?
  voidedAt       DateTime?

  // Honesty flags (PDF §2, §52 - mandatory)
  isUnverified         Boolean            @default(false)
  verificationStatus   VerificationStatus @default(VERIFIED)
  verifiedById         String?
  verifiedAt           DateTime?
  verificationNotes    String?

  documentId   String?
  document     Document?        @relation(fields: [documentId], references: [id])
  createdById  String?
  createdBy    User?            @relation("JournalEntryCreatedBy", fields: [createdById], references: [id])
  createdAt    DateTime         @default(now())
  updatedById  String?
  updatedBy    User?            @relation("JournalEntryUpdatedBy", fields: [updatedById], references: [id])
  updatedAt    DateTime         @updatedAt
  deletedAt    DateTime?        // only permitted while DRAFT or VOIDED

  lines            JournalLine[]
  transaction      Transaction?
  transfer         Transfer?
  payment          Payment?
  creditNote       CreditNote?
  debitNote        DebitNote?
  reconAdjustments ReconciliationAdjustment[]
  generatedOpeningBalances OpeningBalance[]
  matchedInReconciliations ReconciliationMatch[]

  reversalChildren   JournalEntry[] @relation("JournalReversal")
  correctionChildren JournalEntry[] @relation("JournalCorrection")

  @@unique([organizationId, entryNumber])
  @@index([periodId, status])
  @@index([entryDate])
  @@index([status])
  @@index([reversesEntryId])
  @@index([correctionOfId])
  @@index([transactionId])
  @@index([documentId])
  @@index([isUnverified, verificationStatus])
  @@map("journal_entries")
}

model JournalLine {
  id             String      @id @default(cuid())
  journalEntryId String
  journalEntry   JournalEntry @relation(fields: [journalEntryId], references: [id], onDelete: Cascade)
  lineNumber     Int
  accountId      String
  account        Account     @relation(fields: [accountId], references: [id])

  // Dimensions are FK COLUMNS, not enums - extensible without migration
  projectId       String?
  project         Project?      @relation(fields: [projectId], references: [id])
  departmentId    String?
  department      Department?   @relation(fields: [departmentId], references: [id])
  costCentreId    String?
  costCentre      CostCentre?   @relation(fields: [costCentreId], references: [id])
  fundingSourceId String?
  fundingSource   FundingSource? @relation(fields: [fundingSourceId], references: [id])
  locationId      String?
  location        Location?     @relation(fields: [locationId], references: [id])

  debit      Decimal @default(0) @db.Decimal(20,6)
  credit     Decimal @default(0) @db.Decimal(20,6)
  currency   String  @db.Char(3)
  baseDebit  Decimal @default(0) @db.Decimal(20,6)
  baseCredit Decimal @default(0) @db.Decimal(20,6)
  description String?

  cashFlowCategory String?         // PDF §47 cash flow statement
  isTaxLine        Boolean         @default(false)
  taxRuleId        String?
  taxRule          TaxRule?        @relation(fields: [taxRuleId], references: [id])
  taxAmount        Decimal?        @db.Decimal(20,6)
  taxDirection     TaxDirection?

  createdAt DateTime @default(now())

  @@unique([journalEntryId, lineNumber])
  @@index([accountId])
  @@index([projectId])
  @@index([departmentId])
  @@index([costCentreId])
  @@index([fundingSourceId])
  @@index([locationId])
  @@map("journal_lines")
}

model ReasonCode {
  id              String             @id @default(cuid())
  code            String             @unique
  category        ReasonCodeCategory
  description     String
  requiresEvidence Boolean           @default(true)
  requiresApproval Boolean           @default(true)
  isActive        Boolean            @default(true)
  appliesTo       String[]

  journalEntries JournalEntry[]
  transactions   Transaction[]
  creditNotes    CreditNote[]
  debitNotes     DebitNote[]
  payments       Payment[]
  reconAdjustments ReconciliationAdjustment[]

  @@map("reason_codes")
}

// Rebuildable performance cache. NEVER authoritative - the GL is JournalLine.
model AccountBalanceSnapshot {
  id          String          @id @default(cuid())
  accountId   String
  account     Account         @relation(fields: [accountId], references: [id], onDelete: Cascade)
  periodId    String
  asOfDate    DateTime        @db.Date
  currency    String          @db.Char(3)
  debitTotal  Decimal         @default(0) @db.Decimal(20,6)
  creditTotal Decimal         @default(0) @db.Decimal(20,6)
  balance     Decimal         @default(0) @db.Decimal(20,6)
  computedAt  DateTime        @default(now())

  @@unique([accountId, periodId, currency])
  @@index([periodId])
  @@index([asOfDate])
  @@map("account_balance_snapshots")
}

// Opening balances (PDF §63) with mandatory honesty flags (PDF §2)
model OpeningBalance {
  id             String          @id @default(cuid())
  organizationId String
  periodId       String
  period         FinancialPeriod @relation(fields: [periodId], references: [id])
  accountId      String
  account        Account         @relation(fields: [accountId], references: [id])
  projectId        String?
  departmentId     String?
  costCentreId     String?
  fundingSourceId  String?
  locationId       String?
  debit          Decimal         @default(0) @db.Decimal(20,6)
  credit         Decimal         @default(0) @db.Decimal(20,6)
  currency       String          @db.Char(3)
  baseAmount     Decimal         @db.Decimal(20,6)
  description    String?

  // PDF §2: historical records are incomplete - must be marked, never faked.
  isUnverified         Boolean            @default(true)
  verificationStatus   VerificationStatus @default(UNVERIFIED)
  verifiedById         String?
  verifiedAt           DateTime?
  verificationNotes    String?

  // Provenance (PDF §52)
  source            String?    // MANUAL | IMPORT | HISTORICAL | DERIVED
  sourceReference   String?
  importBatchId     String?
  importBatch       ImportBatch? @relation(fields: [importBatchId], references: [id])
  generatedEntryId  String?
  generatedEntry    JournalEntry? @relation(fields: [generatedEntryId], references: [id])

  createdById String
  createdAt   DateTime @default(now())
  updatedById String?
  updatedAt   DateTime @updatedAt

  @@index([periodId])
  @@index([accountId])
  @@index([isUnverified, verificationStatus])
  @@map("opening_balances")
}

// ===========================================================================
// B5. TRANSACTIONS  (PDF §8 workflow, §9 corrections, §52 provenance)
// ===========================================================================

model Transaction {
  id               String          @id @default(cuid())
  organizationId   String
  transactionNumber String
  transactionDate  DateTime        @db.Date
  periodId         String?
  period           FinancialPeriod? @relation(fields: [periodId], references: [id])
  description      String
  amount           Decimal         @db.Decimal(20,6)
  currency         String          @db.Char(3)
  baseAmount       Decimal         @db.Decimal(20,6)
  exchangeRateId   String?
  exchangeRate     ExchangeRate?   @relation(fields: [exchangeRateId], references: [id])
  fxDifferenceAmount Decimal?      @db.Decimal(20,6)

  // ---- Dimensions (PDF §8, BUILD_PROMPT §6) ----
  projectId        String?
  project          Project?        @relation(fields: [projectId], references: [id])
  departmentId     String?
  department       Department?     @relation(fields: [departmentId], references: [id])
  costCentreId     String?
  costCentre       CostCentre?     @relation(fields: [costCentreId], references: [id])
  fundingSourceId  String?
  fundingSource    FundingSource?  @relation(fields: [fundingSourceId], references: [id])
  locationId       String?
  location         Location?       @relation(fields: [locationId], references: [id])

  // Accounting classification
  accountId        String
  account          Account         @relation(fields: [accountId], references: [id])
  counterAccountId String?

  paymentMethod      PaymentMethod
  treasuryAccountId  String?
  treasuryAccount    TreasuryAccount? @relation(fields: [treasuryAccountId], references: [id])
  journalEntryId     String?  @unique
  journalEntry       JournalEntry? @relation(fields: [journalEntryId], references: [id])

  // Evidence (PDF §8 "Supporting document")
  documentId        String?
  document          Document?      @relation("TransactionPrimaryDocument", fields: [documentId], references: [id])
  supportingDocumentIds String[]    @default([])

  // ---- Workflow (PDF §8) ----
  status            TransactionStatus @default(DRAFT)
  submittedById     String?
  submittedAt       DateTime?
  approvedById      String?
  approvedAt        DateTime?
  approvalRequestId String?
  approvalRequest   ApprovalRequest? @relation(fields: [approvalRequestId], references: [id])
  postedById        String?
  postedAt          DateTime?
  lockedAt          DateTime?
  rejectedById      String?
  rejectedAt        DateTime?
  rejectionReason   String?
  rejectedReasonCodeId String?

  // ---- Corrections (PDF §9) ----
  isAdjustment        Boolean       @default(false)
  adjustsTransactionId String?
  adjustsTransaction   Transaction? @relation("TransactionAdjustment", fields: [adjustsTransactionId], references: [id])
  adjustedByTransactions Transaction[] @relation("TransactionAdjustment")
  isReversal          Boolean       @default(false)
  reversalType        ReversalType?
  reversesTransactionId String?
  reversesTransaction  Transaction? @relation("TransactionReversal", fields: [reversesTransactionId], references: [id])
  reversedByTransactionId String?
  reversedByTransaction  Transaction? @relation("TransactionReversal")
  reasonCodeId        String?
  reasonCode          ReasonCode?   @relation(fields: [reasonCodeId], references: [id])
  correctionNotes     String?

  // ---- Honesty flags (PDF §2, §52 - mandatory) ----
  isUnverified         Boolean            @default(false)
  verificationStatus   VerificationStatus @default(VERIFIED)
  verifiedById         String?
  verifiedAt           DateTime?
  verificationNotes    String?

  // ---- Provenance ----
  source         String?        // MANUAL | IMPORT | API | HISTORICAL | OFFLINE_SYNC
  sourceReference String?
  importBatchId  String?
  importBatch    ImportBatch?   @relation(fields: [importBatchId], references: [id])
  importRowId    String?

  anomalyFlags   AnomalyFlag[]
  createdById    String
  createdBy      User?         @relation("TransactionCreatedBy", fields: [createdById], references: [id])
  createdAt      DateTime      @default(now())
  updatedById    String?
  updatedBy      User?         @relation("TransactionUpdatedBy", fields: [updatedById], references: [id])
  updatedAt      DateTime      @updatedAt
  deletedAt      DateTime?     // only while DRAFT

  @@unique([organizationId, transactionNumber])
  @@index([status])
  @@index([transactionDate])
  @@index([accountId])
  @@index([projectId])
  @@index([departmentId])
  @@index([costCentreId])
  @@index([fundingSourceId])
  @@index([locationId])
  @@index([isUnverified, verificationStatus])
  @@index([periodId])
  @@index([createdById])
  @@map("transactions")
}
```

### 3.4 Models — Treasury, statement import, reconciliation

```prisma
// ===========================================================================
// B6. CASH, BANK, MOBILE MONEY, GATEWAYS, PROJECT & GRANT FUNDS  (PDF §10)
// ===========================================================================

model TreasuryAccount {
  // ONE table covering PDF §10's Cash / Bank / Mobile-money / Payment gateway /
  // Project fund / Grant fund / "Future accounts" via `kind`.
  // Rationale: PDF §10 explicitly requires "future accounts" support and
  // PDF §12 requires reconciliation across all of these - a discriminator is
  // strictly more extensible than four separate tables.
  id              String              @id @default(cuid())
  organizationId  String
  code            String
  name            String
  kind            TreasuryAccountKind
  ledgerAccountId String
  ledgerAccount   Account             @relation(fields: [ledgerAccountId], references: [id])
  currency        String              @db.Char(3)
  holderType      AccountHolderType   @default(ORGANIZATION)
  holderName      String?
  bankName        String?
  branchName      String?
  accountNumberEnc    String?          // encrypted at rest
  accountNumberLast4  String?
  mobileMoneyProvider String?
  mobileMoneyAccountEnc String?
  gatewayProvider String?
  gatewayMerchantRef String?
  iban            String?
  swiftCode       String?
  locationId      String?
  location        Location?           @relation(fields: [locationId], references: [id])
  projectId       String?
  project         Project?            @relation(fields: [projectId], references: [id])
  fundingSourceId String?
  fundingSource   FundingSource?      @relation(fields: [fundingSourceId], references: [id])
  isRestricted    Boolean             @default(false)
  openingBalance  Decimal?            @db.Decimal(20,6)
  isActive        Boolean             @default(true)
  isPrimary       Boolean             @default(false)
  status          MasterDataStatus    @default(ACTIVE)
  // Bank accounts only: reconciliation-relevant bank metadata
  statementFormat String?             // configurable, no hardcoded per-bank parsers
  statementDayOfMonth Int?
  createdById     String?
  createdAt       DateTime            @default(now())
  updatedById     String?
  updatedAt       DateTime            @updatedAt

  transactions     Transaction[]
  transfersFrom    Transfer[]         @relation("TransferFrom")
  transfersTo      Transfer[]         @relation("TransferTo")
  reconciliations  ReconciliationSession[]
  imports          BankStatementImport[]
  paymentSchedules PaymentSchedule[]
  payments         Payment[]

  @@unique([organizationId, code])
  @@index([kind, isActive])
  @@index([ledgerAccountId])
  @@index([fundingSourceId])
  @@map("treasury_accounts")
}

// PDF §10 VERBATIM: "Transfers between accounts must not incorrectly appear as
// revenue or expenses."
// => Transfer is an AGGREGATE VIEW over a paired JournalEntry. It is never an
// independent writer of ledger truth. The balancing invariant is structural:
// the underlying entry has one credit to the source and one debit to the
// destination, both classified as CASH/BANK/MOBILE_MONEY, never REVENUE/EXPENSE.
model Transfer {
  id             String          @id @default(cuid())
  organizationId String
  transferNumber String
  transferDate   DateTime        @db.Date
  fromAccountId  String
  fromAccount    TreasuryAccount @relation("TransferFrom", fields: [fromAccountId], references: [id])
  toAccountId    String
  toAccount      TreasuryAccount @relation("TransferTo", fields: [toAccountId], references: [id])
  amount         Decimal         @db.Decimal(20,6)
  feeAmount      Decimal?        @db.Decimal(20,6)
  feeAccountId   String?
  currency       String          @db.Char(3)
  baseAmount     Decimal         @db.Decimal(20,6)
  fxDifferenceAmount Decimal?     @db.Decimal(20,6)
  purpose        String
  status         TransferStatus  @default(DRAFT)
  journalEntryId String          @unique
  journalEntry   JournalEntry    @relation(fields: [journalEntryId], references: [id])
  approvalRequestId String?
  submittedById  String?
  submittedAt    DateTime?
  approvedById   String?
  approvedAt     DateTime?
  processedById  String?
  processedAt    DateTime?
  // If source and destination currencies differ, reversal returns to origin
  isReversal       Boolean       @default(false)
  reversesTransferId String?
  reversesTransfer   Transfer?    @relation("TransferReversal", fields: [reversesTransferId], references: [id])
  reversedByTransferId String?
  reversedByTransfer   Transfer?  @relation("TransferReversal")
  reasonCodeId     String?
  documentId       String?
  document         Document?     @relation(fields: [documentId], references: [id])
  isUnverified         Boolean            @default(false)
  verificationStatus   VerificationStatus @default(VERIFIED)
  createdById    String
  createdAt      DateTime        @default(now())
  updatedById    String?
  updatedAt      DateTime        @updatedAt

  reversalChildren Transfer[] @relation("TransferReversal")

  @@unique([organizationId, transferNumber])
  @@index([transferDate])
  @@index([status])
  @@index([fromAccountId])
  @@index([toAccountId])
  @@map("transfers")
}

model PaymentSchedule {
  id                String                @id @default(cuid())
  organizationId    String
  treasuryAccountId String?
  treasuryAccount   TreasuryAccount?      @relation(fields: [treasuryAccountId], references: [id])
  sourceType        String                // INVOICE|SUPPLIER_BILL|COMMITMENT|MANUAL
  sourceId          String?
  partyId           String?
  dueDate           DateTime              @db.Date
  amount            Decimal               @db.Decimal(20,6)
  paidAmount        Decimal               @default(0) @db.Decimal(20,6)
  currency          String                @db.Char(3)
  status            PaymentScheduleStatus @default(SCHEDULED)
  remindersSent     Int                   @default(0)
  lastReminderAt    DateTime?
  notes             String?
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  @@index([dueDate, status])
  @@index([treasuryAccountId])
  @@map("payment_schedules")
}

// ===========================================================================
// B7. BANK STATEMENT IMPORT  (PDF §11) + RECONCILIATION  (PDF §12)
// ===========================================================================

model BankStatementImport {
  id                String             @id @default(cuid())
  organizationId    String
  treasuryAccountId String
  treasuryAccount   TreasuryAccount    @relation(fields: [treasuryAccountId], references: [id])
  fileName          String
  fileStorageKey    String?
  fileHash          String             // duplicate-upload detection
  source            ImportSource       @default(CSV)
  statementPeriodStart DateTime        @db.Date
  statementPeriodEnd   DateTime        @db.Date
  statementOpeningBalance Decimal?     @db.Decimal(20,6)
  statementClosingBalance Decimal?     @db.Decimal(20,6)
  currency          String             @db.Char(3)
  status            ImportBatchStatus  @default(UPLOADED)
  mappingId         String?
  mapping           ImportFieldMapping? @relation(fields: [mappingId], references: [id])
  totalRows         Int                @default(0)
  validRows         Int                @default(0)
  errorRows         Int                @default(0)
  duplicateRows     Int                @default(0)
  importedRows      Int                @default(0)
  importedAmount    Decimal?           @db.Decimal(20,6)
  approvedById      String?
  approvedAt        DateTime?
  importedAt        DateTime?
  rolledBackAt      DateTime?
  rollbackReason    String?
  createdById       String
  createdAt         DateTime           @default(now())
  updatedAt         DateTime           @updatedAt

  lines                BankStatementLine[]
  errors               ImportError[]
  reconciliationSessions ReconciliationSession[]

  @@unique([organizationId, fileHash])   // same file cannot be uploaded twice
  @@index([status])
  @@index([treasuryAccountId])
  @@map("bank_statement_imports")
}

model ImportFieldMapping {
  id                String            @id @default(cuid())
  organizationId    String
  name              String
  treasuryAccountId String?
  sourceType        ImportSource      @default(CSV)
  bankName          String?
  mappingJson       Json              // source column -> canonical field
  dateFormat        String?
  amountConvention  String?           // SINGLE_COLUMN | SEPARATE_DEBIT_CREDIT | SIGNED
  headerRowNumber   Int               @default(1)
  dataStartRow      Int?
  skipFooterRows    Boolean           @default(false)
  isDefault         Boolean           @default(false)
  createdById       String?
  createdAt         DateTime          @default(now())
  updatedAt         DateTime          @updatedAt

  imports BankStatementImport[]

  @@index([organizationId])
  @@map("import_field_mappings")
}

model BankStatementLine {
  id                String              @id @default(cuid())
  importId          String
  import            BankStatementImport @relation(fields: [importId], references: [id], onDelete: Cascade)
  rowNumber         Int
  rawData           Json                // PDF §52: ORIGINAL INFORMATION preserved
  lineDate          DateTime?           @db.Date
  valueDate         DateTime?           @db.Date
  description       String?
  reference         String?
  debitAmount       Decimal?            @db.Decimal(20,6)
  creditAmount      Decimal?            @db.Decimal(20,6)
  amount            Decimal?            @db.Decimal(20,6)
  currency          String?             @db.Char(3)
  balance           Decimal?            @db.Decimal(20,6)
  // Duplicate detection (PDF §11, §12)
  fingerprint       String              // normalised amount + date + reference hash
  isDuplicate       Boolean             @default(false)
  duplicateOfId     String?
  validationStatus  String              @default("PENDING") // PENDING|VALID|ERROR|DUPLICATE|EXCLUDED
  validationErrors  Json?
  // Provenance (PDF §52: source, import date, verification status)
  source            String?
  sourceReference   String?
  importDate        DateTime?
  verificationStatus VerificationStatus @default(PENDING_VERIFICATION)
  verifiedById      String?
  verifiedAt        DateTime?
  matched           Boolean             @default(false)
  createdAt         DateTime            @default(now())

  matches ReconciliationMatch[]

  @@unique([importId, rowNumber])
  @@index([fingerprint])
  @@index([lineDate])
  @@index([matched])
  @@index([validationStatus])
  @@index([isDuplicate])
  @@map("bank_statement_lines")
}

model MatchingRule {
  id              String             @id @default(cuid())
  organizationId  String
  name            String
  target          ReconciliationTarget
  priority        Int                @default(100)
  // Ordered criteria: exact amount, date window, reference contains, ...
  conditions      Json
  toleranceAmount Decimal?           @db.Decimal(20,6)
  toleranceDays   Int?
  isActive        Boolean            @default(true)
  createdById     String?
  createdAt       DateTime           @default(now())
  updatedAt       DateTime           @updatedAt

  @@index([organizationId, target, isActive])
  @@map("matching_rules")
}

model ReconciliationSession {
  id                String               @id @default(cuid())
  organizationId    String
  treasuryAccountId String
  treasuryAccount   TreasuryAccount      @relation(fields: [treasuryAccountId], references: [id])
  importId          String?
  import            BankStatementImport? @relation(fields: [importId], references: [id])
  target            ReconciliationTarget
  periodId          String?
  period            FinancialPeriod?     @relation(fields: [periodId], references: [id])
  status            ReconciliationStatus @default(NOT_STARTED)
  statementStartDate    DateTime?        @db.Date
  statementEndDate      DateTime?        @db.Date
  statementOpeningBalance Decimal?       @db.Decimal(20,6)
  statementClosingBalance Decimal?       @db.Decimal(20,6)
  bookBalanceBeginning   Decimal?       @db.Decimal(20,6)
  bookBalanceEnding      Decimal?       @db.Decimal(20,6)
  calculatedEndingBalance Decimal?      @db.Decimal(20,6)
  difference            Decimal?       @db.Decimal(20,6)
  currency          String               @db.Char(3)
  matchingRulesApplied Json?
  autoMatchThreshold Int                 @default(85)
  // PDF §12 approval
  startedById      String?
  startedAt        DateTime?
  reviewedById     String?
  reviewedAt       DateTime?
  approvedById     String?
  approvedAt       DateTime?
  lockedAt         DateTime?
  reopenedAt       DateTime?
  reopenReason     String?
  notes            String?
  createdAt        DateTime             @default(now())
  updatedAt        DateTime             @updatedAt

  matches     ReconciliationMatch[]
  exceptions  ReconciliationException[]
  adjustments ReconciliationAdjustment[]

  @@unique([organizationId, treasuryAccountId, statementStartDate, statementEndDate])
  @@index([status])
  @@index([periodId])
  @@index([treasuryAccountId])
  @@map("reconciliation_sessions")
}

model ReconciliationMatch {
  id                String                    @id @default(cuid())
  sessionId         String
  session           ReconciliationSession     @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  statementLineId   String?
  statementLine     BankStatementLine?        @relation(fields: [statementLineId], references: [id])
  // Polymorphic target (PDF §12: bank/cash/mobile money/gateway/project/grant/imported)
  entityType        AuditEntityType
  entityId          String
  transactionId     String?
  transaction       Transaction?              @relation(fields: [transactionId], references: [id])
  journalEntryId    String?
  journalEntry      JournalEntry?             @relation(fields: [journalEntryId], references: [id])
  paymentId         String?
  payment           Payment?                  @relation(fields: [paymentId], references: [id])
  matchType         MatchType                 @default(MANUAL)
  status            ReconciliationLineStatus  @default(PROPOSED)
  matchedAmount     Decimal                   @db.Decimal(20,6)
  confidence        Int?                      // 0-100 for auto-matches
  differenceReason  String?
  isManual          Boolean                   @default(false)
  matchedById       String?
  matchedAt         DateTime?
  confirmedById     String?
  confirmedAt       DateTime?
  createdAt         DateTime                  @default(now())

  @@unique([sessionId, statementLineId, entityType, entityId])
  @@index([sessionId, status])
  @@index([statementLineId])
  @@index([entityType, entityId])
  @@index([transactionId])
  @@map("reconciliation_matches")
}

model ReconciliationException {
  id                String                    @id @default(cuid())
  sessionId         String
  session           ReconciliationSession     @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  statementLineId   String?
  entityType        AuditEntityType?
  entityId          String?
  exceptionType     AnomalyType
  severity          AnomalySeverity           @default(MEDIUM)
  description       String
  suggestedResolution String?
  resolution        String?
  status            ReconciliationLineStatus  @default(EXCEPTION)
  resolvedById      String?
  resolvedAt        DateTime?
  createdAt         DateTime                  @default(now())

  @@index([sessionId, status])
  @@map("reconciliation_exceptions")
}

model ReconciliationAdjustment {
  id                String                          @id @default(cuid())
  sessionId         String
  session           ReconciliationSession           @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  accountId         String
  description       String
  debit             Decimal  @default(0) @db.Decimal(20,6)
  credit            Decimal  @default(0) @db.Decimal(20,6)
  currency          String   @db.Char(3)
  status            ReconciliationAdjustmentStatus  @default(DRAFT)
  reasonCodeId      String?
  reasonCode        ReasonCode? @relation(fields: [reasonCodeId], references: [id])
  approvalRequestId String?
  approvalRequest   ApprovalRequest? @relation(fields: [approvalRequestId], references: [id])
  journalEntryId    String?
  journalEntry      JournalEntry?  @relation(fields: [journalEntryId], references: [id])
  documentId        String?
  postedById        String?
  postedAt          DateTime?
  createdById       String
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  @@index([sessionId])
  @@map("reconciliation_adjustments")
}
```

### 3.5 Models — Budgets, parties, sales, payments

```prisma
// ===========================================================================
// B8. BUDGETS & COMMITMENTS  (PDF §13, PDF §67)
// ===========================================================================

model Budget {
  id             String          @id @default(cuid())
  organizationId String
  code           String
  name           String
  level          BudgetLevel
  status         BudgetStatus    @default(DRAFT)
  periodId       String
  period         FinancialPeriod @relation(fields: [periodId], references: [id])
  periodType     BudgetPeriodType @default(MONTHLY)
  currency       String          @db.Char(3)
  approvedAmount Decimal         @default(0) @db.Decimal(20,6)
  // Derived: approved - commitments - actual (PDF §13, §67). Cached for lists.
  committedAmount   Decimal       @default(0) @db.Decimal(20,6)
  actualAmount      Decimal       @default(0) @db.Decimal(20,6)
  availableAmount   Decimal       @default(0) @db.Decimal(20,6)
  isOverBudget      Boolean       @default(false)
  ownerUserId    String?
  description    String?
  notes          String?
  approvedById   String?
  approvedAt     DateTime?
  activatedAt    DateTime?
  closedAt       DateTime?
  createdById    String
  createdAt      DateTime        @default(now())
  updatedById    String?
  updatedAt      DateTime        @updatedAt
  deletedAt      DateTime?

  // Dimensions
  projectId        String?
  project          Project?       @relation(fields: [projectId], references: [id])
  departmentId     String?
  department       Department?    @relation(fields: [departmentId], references: [id])
  costCentreId     String?
  costCentre       CostCentre?    @relation(fields: [costCentreId], references: [id])
  fundingSourceId  String?
  fundingSource    FundingSource? @relation(fields: [fundingSourceId], references: [id])
  locationId       String?
  location         Location?      @relation(fields: [locationId], references: [id])

  lines       BudgetLine[]
  revisions   BudgetRevision[]
  transfers   BudgetTransfer[]
  commitments Commitment[]
  scenarios   BudgetScenario[]

  @@unique([organizationId, code])
  @@index([status])
  @@index([periodId])
  @@index([projectId])
  @@index([departmentId])
  @@index([fundingSourceId])
  @@map("budgets")
}

model BudgetLine {
  id              String  @id @default(cuid())
  budgetId        String
  budget          Budget  @relation(fields: [budgetId], references: [id], onDelete: Cascade)
  accountId       String
  account         Account @relation(fields: [accountId], references: [id])
  description     String?
  approvedAmount  Decimal @default(0) @db.Decimal(20,6)
  revisedAmount   Decimal @default(0) @db.Decimal(20,6)
  committedAmount Decimal @default(0) @db.Decimal(20,6)
  actualAmount    Decimal @default(0) @db.Decimal(20,6)
  availableAmount Decimal @default(0) @db.Decimal(20,6)
  // Monthly phasing for monthly budgets
  periodStart     DateTime? @db.Date
  periodEnd       DateTime? @db.Date
  warningsEnabled Boolean   @default(true)
  isOverBudget    Boolean   @default(false)

  @@unique([budgetId, accountId, periodStart])
  @@index([budgetId])
  @@index([accountId])
  @@index([isOverBudget])
  @@map("budget_lines")
}

model BudgetRevision {
  id               String    @id @default(cuid())
  budgetId         String
  budget           Budget    @relation(fields: [budgetId], references: [id], onDelete: Cascade)
  revisionNumber   Int
  previousTotal    Decimal   @db.Decimal(20,6)
  newTotal         Decimal   @db.Decimal(20,6)
  reason           String
  effectiveDate    DateTime  @db.Date
  status           String    @default("PENDING") // PENDING|APPROVED|REJECTED|APPLIED
  approvalRequestId String?
  approvalRequest   ApprovalRequest? @relation(fields: [approvalRequestId], references: [id])
  changesJson      Json?
  createdById      String
  createdAt        DateTime  @default(now())
  decidedById      String?
  decidedAt        DateTime?

  lines BudgetRevisionLine[]

  @@unique([budgetId, revisionNumber])
  @@index([budgetId, status])
  @@map("budget_revisions")
}

model BudgetRevisionLine {
  id             String         @id @default(cuid())
  revisionId     String
  revision       BudgetRevision @relation(fields: [revisionId], references: [id], onDelete: Cascade)
  accountId      String
  previousAmount Decimal        @db.Decimal(20,6)
  newAmount      Decimal        @db.Decimal(20,6)
  note           String?

  @@index([revisionId])
  @@map("budget_revision_lines")
}

model BudgetTransfer {
  id               String   @id @default(cuid())
  budgetId         String
  budget           Budget   @relation(fields: [budgetId], references: [id], onDelete: Cascade)
  transferNumber   String
  fromAccountId    String
  toAccountId      String
  amount           Decimal  @db.Decimal(20,6)
  currency         String   @db.Char(3)
  reason           String
  effectiveDate    DateTime @db.Date
  status           String   @default("PENDING")
  approvalRequestId String?
  createdById      String
  createdAt        DateTime @default(now())
  approvedById     String?
  approvedAt       DateTime?

  @@index([budgetId, status])
  @@map("budget_transfers")
}

// PDF §13 + §67:  Budget - Commitments - Actual = Remaining Available
model Commitment {
  id             String           @id @default(cuid())
  organizationId String
  budgetId       String?
  budget         Budget?          @relation(fields: [budgetId], references: [id])
  accountId      String
  account        Account          @relation(fields: [accountId], references: [id])
  source         CommitmentSource
  sourceId       String?
  partyId        String?
  commitmentDate DateTime         @db.Date
  expectedDate   DateTime?        @db.Date
  amount         Decimal          @db.Decimal(20,6)
  settledAmount  Decimal          @default(0) @db.Decimal(20,6)
  currency       String           @db.Char(3)
  status         CommitmentStatus @default(OPEN)
  projectId      String?
  departmentId   String?
  costCentreId   String?
  fundingSourceId String?
  locationId     String?
  description    String
  approvalRequestId String?
  createdById    String
  createdAt      DateTime         @default(now())
  updatedAt      DateTime         @updatedAt
  releasedAt     DateTime?

  @@index([budgetId, status])
  @@index([status, expectedDate])
  @@index([commitmentDate])
  @@index([accountId])
  @@map("commitments")
}

// Lightweight scenario planning (PDF §13). Full forecasting is Phase 2.
model BudgetScenario {
  id                String       @id @default(cuid())
  budgetId          String
  budget            Budget       @relation(fields: [budgetId], references: [id], onDelete: Cascade)
  kind              ScenarioKind
  name              String
  assumptions       Json
  projectedTotal    Decimal?     @db.Decimal(20,6)
  projectedCommitted Decimal?    @db.Decimal(20,6)
  projectedActual   Decimal?     @db.Decimal(20,6)
  projectedAvailable Decimal?    @db.Decimal(20,6)
  notes             String?
  createdById       String
  createdAt         DateTime     @default(now())

  @@index([budgetId])
  @@map("budget_scenarios")
}

// ===========================================================================
// B9. PARTIES: CUSTOMERS & SUPPLIERS  (PDF §15, §17, §21, §23)
// ===========================================================================

// Shared base so contacts/addresses/communications are not duplicated per type.
model Party {
  id             String            @id @default(cuid())
  organizationId String
  type           PartyType
  code           String?
  name           String
  tradingName    String?
  isActive       Boolean           @default(true)
  createdAt      DateTime          @default(now())
  updatedAt      DateTime          @updatedAt
  deletedAt      DateTime?

  contacts       Contact[]
  addresses      PartyAddress[]
  communications CommunicationLog[]

  customer Customer?
  supplier Supplier?

  @@unique([organizationId, name])
  @@index([type, isActive])
  @@map("parties")
}

model PartyAddress {
  id         String  @id @default(cuid())
  partyId    String
  party      Party   @relation(fields: [partyId], references: [id], onDelete: Cascade)
  label      String?
  line1      String?
  line2      String?
  city       String?
  region     String?
  country    String  @default("Tanzania")
  postalCode String?
  isPrimary  Boolean @default(false)
  locationId String?

  @@index([partyId])
  @@map("party_addresses")
}

model Contact {
  id         String  @id @default(cuid())
  partyId    String?
  party      Party?  @relation(fields: [partyId], references: [id], onDelete: Cascade)
  firstName  String
  lastName   String
  email      String?
  phone      String?
  jobTitle   String?
  isPrimary  Boolean @default(true)
  isActive   Boolean @default(true)
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  @@index([partyId])
  @@index([email])
  @@map("contacts")
}

model CommunicationLog {
  id               String    @id @default(cuid())
  organizationId   String
  partyId          String?
  party            Party?    @relation(fields: [partyId], references: [id], onDelete: SetNull)
  channel          String    // EMAIL|PHONE|MEETING|MESSAGE|INTERNAL_NOTE
  subject          String?
  summary          String
  occurredAt       DateTime  @default(now())
  relatedEntityType String?
  relatedEntityId  String?
  followUpAt       DateTime?
  followUpDone     Boolean   @default(false)
  documentId       String?
  createdById      String

  @@index([partyId, occurredAt])
  @@index([relatedEntityType, relatedEntityId])
  @@map("communication_logs")
}

model Customer {
  id             String           @id @default(cuid())
  organizationId String
  partyId        String           @unique
  party          Party            @relation(fields: [partyId], references: [id])
  customerNumber String
  status         CustomerStatus   @default(PROSPECT)
  taxNumber      String?
  isTaxExempt    Boolean          @default(false)
  currency       String           @default("TZS") @db.Char(3)
  paymentTerms   PaymentTermsCode @default(NET_30)
  paymentTermsDays Int            @default(30)
  // PDF §17 credit management
  creditLimit    Decimal?         @db.Decimal(20,6)
  creditLimitCurrency String?     @db.Char(3)
  creditHold     Boolean          @default(false)
  creditHoldReason String?
  creditHoldAt   DateTime?
  creditHoldById String?
  riskLevel      PartyRiskLevel   @default(LOW)
  riskNotes      String?
  relationshipOwnerId String?
  locationId     String?
  location       Location?        @relation(fields: [locationId], references: [id])
  projectId      String?
  project        Project?         @relation(fields: [projectId], references: [id])
  outstandingBalance Decimal?      @db.Decimal(20,6)
  badDebtAmount  Decimal?         @db.Decimal(20,6)
  onboardingDate DateTime?
  notes          String?
  masterStatus   MasterDataStatus @default(ACTIVE)
  createdById    String?
  createdAt      DateTime         @default(now())
  updatedById    String?
  updatedAt      DateTime         @updatedAt
  deletedAt      DateTime?

  contacts     Contact[]
  invoices     Invoice[]
  quotations   Quotation[]
  payments     Payment[]
  receipts     Receipt[]
  creditNotes  CreditNote[]

  @@unique([organizationId, customerNumber])
  @@index([status])
  @@index([creditHold])
  @@index([riskLevel])
  @@index([locationId])
  @@map("customers")
}

model Supplier {
  id             String           @id @default(cuid())
  organizationId String
  partyId        String           @unique
  party          Party            @relation(fields: [partyId], references: [id])
  supplierNumber String
  status         SupplierStatus   @default(PROSPECT)
  taxNumber      String?
  isTaxExempt    Boolean          @default(false)
  currency       String           @default("TZS") @db.Char(3)
  paymentTerms   PaymentTermsCode @default(NET_30)
  paymentTermsDays Int            @default(30)
  riskLevel      PartyRiskLevel   @default(LOW)
  riskNotes      String?
  relationshipOwnerId String?
  locationId     String?
  location       Location?        @relation(fields: [locationId], references: [id])
  // PDF §21 performance / quality tracking (lightweight)
  performanceRating  Decimal?      @db.Decimal(5,2)
  deliveryRating     Decimal?      @db.Decimal(5,2)
  qualityRating      Decimal?      @db.Decimal(5,2)
  onTimeDeliveryRate Decimal?      @db.Decimal(5,2)
  lastReviewedAt DateTime?
  notes          String?
  masterStatus   MasterDataStatus @default(ACTIVE)
  createdById    String?
  createdAt      DateTime         @default(now())
  updatedById    String?
  updatedAt      DateTime         @updatedAt
  deletedAt      DateTime?

  contacts         Contact[]
  bankDetails      SupplierBankDetail[]
  payments         Payment[]
  taxObligations   TaxObligation[]

  @@unique([organizationId, supplierNumber])
  @@index([status])
  @@index([riskLevel])
  @@map("suppliers")
}

// PDF §23 SUPPLIER PAYMENT SECURITY
model SupplierBankDetail {
  id                String  @id @default(cuid())
  supplierId        String
  supplier          Supplier @relation(fields: [supplierId], references: [id], onDelete: Cascade)
  bankName          String
  branchName        String?
  accountNumberEnc  String                 // encrypted at rest
  accountNumberLast4 String
  accountHolder     String
  swiftCode         String?
  iban              String?
  mobileMoneyProvider String?
  mobileMoneyAccountEnc String?
  currency          String  @db.Char(3)
  country           String  @default("Tanzania")
  isActive          Boolean @default(true)
  isPrimary         Boolean @default(false)

  // PDF §23 mandatory controls
  changeState       String  @default("ACTIVE") // ACTIVE|CHANGE_PENDING|VERIFICATION_PENDING|REJECTED
  changeRequestId   String?
  changeRequest     SupplierBankDetailChangeRequest? @relation(fields: [changeRequestId], references: [id])
  verifiedAt        DateTime?
  verifiedById      String?
  // Payments to this supplier are BLOCKED until the change is approved+verified.
  paymentBlocked    Boolean @default(false)
  paymentBlockedUntil DateTime?

  effectiveFrom     DateTime @default(now())
  effectiveTo       DateTime?
  createdById       String
  createdAt         DateTime @default(now())
  updatedById       String?
  updatedAt         DateTime @updatedAt
  deletedAt         DateTime?   // never hard delete - previous values preserved

  @@index([supplierId, isActive])
  @@index([changeState])
  @@index([paymentBlocked])
  @@map("supplier_bank_details")
}

model SupplierBankDetailChangeRequest {
  id                String   @id @default(cuid())
  organizationId    String
  supplierId        String
  previousValues    Json     // PDF §23 "Previous-value preservation"
  newValues         Json
  changeReason      String
  evidenceDocumentId String?
  status            String   @default("PENDING") // PENDING|VERIFIED|APPROVED|REJECTED|APPLIED
  // Maker-checker (PDF §23): requester can NEVER approve their own change
  requestedById     String
  requestedAt       DateTime @default(now())
  verifiedById      String?
  verifiedAt        DateTime?
  verificationMethod String?
  approvalRequestId String?
  approvalRequest   ApprovalRequest? @relation(fields: [approvalRequestId], references: [id])
  approvedById      String?
  approvedAt        DateTime?
  rejectedById      String?
  rejectedAt        DateTime?
  rejectionReason   String?
  notifiedAt        DateTime?
  notifiedUserIds   String[] @default([])
  // Anti-fraud: no payment to the new destination during the control window
  paymentsBlocked   Boolean  @default(true)
  effectiveFrom     DateTime?

  @@index([supplierId, status])
  @@index([status])
  @@map("supplier_bank_detail_change_requests")
}
```

### 3.6 Models — Sales documents, documents/evidence, approvals, audit, and support

```prisma
// ===========================================================================
// B10. QUOTATIONS, INVOICES, PAYMENTS, RECEIPTS, CREDIT/DEBIT NOTES
//      (PDF §14, §16, §17, §32, §8)
// ===========================================================================

model Quotation {
  id               String              @id @default(cuid())
  organizationId   String
  quotationNumber  String
  customerId       String
  customer         Customer            @relation(fields: [customerId], references: [id])
  quotationDate    DateTime            @db.Date
  validUntil       DateTime?           @db.Date
  status           QuotationStatus     @default(DRAFT)
  currency         String              @db.Char(3)
  subtotal         Decimal             @default(0) @db.Decimal(20,6)
  taxTotal         Decimal             @default(0) @db.Decimal(20,6)
  discountTotal    Decimal             @default(0) @db.Decimal(20,6)
  total            Decimal             @default(0) @db.Decimal(20,6)
  exchangeRateId   String?
  baseTotal        Decimal?            @db.Decimal(20,6)
  projectId        String?
  locationId       String?
  notes            String?
  terms            String?
  approvalRequestId String?
  submittedById    String?
  submittedAt      DateTime?
  approvedById     String?
  approvedAt       DateTime?
  sentAt           DateTime?
  acceptedAt       DateTime?
  convertedInvoiceId String?           @unique
  convertedInvoice   Invoice?         @relation("QuotationToInvoice", fields: [convertedInvoiceId], references: [id])
  sourceQuotationId  String?
  sourceQuotation    Quotation?       @relation("QuotationRecurring", fields: [sourceQuotationId], references: [id])
  recurrence       RecurrenceFrequency @default(NONE)
  nextRecurrenceDate DateTime?        @db.Date
  documentId       String?
  createdById      String
  createdAt        DateTime            @default(now())
  updatedById      String?
  updatedAt        DateTime            @updatedAt
  deletedAt        DateTime?

  lines QuotationLine[]
  recurrenceChildren Quotation[]       @relation("QuotationRecurring")

  @@unique([organizationId, quotationNumber])
  @@index([customerId, status])
  @@index([quotationDate])
  @@index([status])
  @@map("quotations")
}

model QuotationLine {
  id              String        @id @default(cuid())
  quotationId     String
  quotation       Quotation     @relation(fields: [quotationId], references: [id], onDelete: Cascade)
  lineNumber      Int
  productServiceId String?
  productService   ProductService? @relation(fields: [productServiceId], references: [id])
  description     String
  quantity        Decimal       @db.Decimal(18,6)
  unitPrice       Decimal       @db.Decimal(20,6)
  discountPercent Decimal?      @db.Decimal(5,2)
  discountAmount  Decimal?      @db.Decimal(20,6)
  lineSubtotal    Decimal       @db.Decimal(20,6)
  taxRuleId       String?
  taxAmount       Decimal?      @db.Decimal(20,6)
  lineTotal       Decimal       @db.Decimal(20,6)
  accountId       String?       // revenue account used on conversion
  projectId       String?
  isActive        Boolean       @default(true)

  @@unique([quotationId, lineNumber])
  @@index([quotationId])
  @@map("quotation_lines")
}

model Invoice {
  id               String              @id @default(cuid())
  organizationId   String
  invoiceNumber    String
  invoiceType      String              @default("STANDARD") // STANDARD|TAX|PROFORMA
  customerId       String
  customer         Customer            @relation(fields: [customerId], references: [id])
  invoiceDate      DateTime            @db.Date
  dueDate          DateTime            @db.Date
  status           InvoiceStatus       @default(DRAFT)
  currency         String              @db.Char(3)
  subtotal         Decimal             @default(0) @db.Decimal(20,6)
  taxTotal         Decimal             @default(0) @db.Decimal(20,6)
  discountTotal    Decimal             @default(0) @db.Decimal(20,6)
  total            Decimal             @default(0) @db.Decimal(20,6)
  paidAmount       Decimal             @default(0) @db.Decimal(20,6)
  creditedAmount   Decimal             @default(0) @db.Decimal(20,6)
  outstandingAmount Decimal            @default(0) @db.Decimal(20,6)
  exchangeRateId   String?
  baseTotal        Decimal?            @db.Decimal(20,6)
  baseOutstanding  Decimal?            @db.Decimal(20,6)
  // Dimensions
  projectId        String?
  project          Project?            @relation(fields: [projectId], references: [id])
  departmentId     String?
  costCentreId     String?
  fundingSourceId  String?
  locationId       String?
  sourceQuotationId String?
  sourceQuotation   Quotation?        @relation("QuotationToInvoice", fields: [sourceQuotationId], references: [id])
  // PDF §16 recurring + partial invoices
  recurrence        RecurrenceFrequency @default(NONE)
  recurrenceParentId String?
  nextRecurrenceDate DateTime?         @db.Date
  // PDF §32 tax invoice - values from TaxRule configuration, NEVER hardcoded
  taxInvoiceNumber  String?
  taxInvoiceValid   Boolean            @default(false)
  taxRulesApplied   Json?
  approvalRequestId String?
  submittedById     String?
  submittedAt       DateTime?
  approvedById      String?
  approvedAt        DateTime?
  sentAt            DateTime?
  cancelledAt       DateTime?
  cancellationReason String?
  // PDF §2: historical invoices are incomplete
  isUnverified         Boolean            @default(false)
  verificationStatus   VerificationStatus @default(VERIFIED)
  documentId       String?
  notes            String?
  terms            String?
  createdById      String
  createdAt        DateTime            @default(now())
  updatedById      String?
  updatedAt        DateTime            @updatedAt
  deletedAt        DateTime?

  lines       InvoiceLine[]
  allocations PaymentAllocation[]
  receipts    Receipt[]
  creditNotes CreditNote[]

  @@unique([organizationId, invoiceNumber])
  @@unique([organizationId, taxInvoiceNumber])
  @@index([customerId, status])
  @@index([invoiceDate])
  @@index([dueDate, status])
  @@index([projectId])
  @@index([status])
  @@map("invoices")
}

model InvoiceLine {
  id              String               @id @default(cuid())
  invoiceId       String
  invoice         Invoice              @relation(fields: [invoiceId], references: [id], onDelete: Cascade)
  lineNumber      Int
  productServiceId String?
  productService   ProductService?     @relation(fields: [productServiceId], references: [id])
  description     String
  quantity        Decimal              @db.Decimal(18,6)
  unitPrice       Decimal              @db.Decimal(20,6)
  discountPercent Decimal?             @db.Decimal(5,2)
  discountAmount  Decimal?             @db.Decimal(20,6)
  lineSubtotal    Decimal              @db.Decimal(20,6)
  taxRuleId       String?
  taxRule         TaxRule?             @relation(fields: [taxRuleId], references: [id])
  taxCalculationBasis TaxCalculationBasis @default(NOT_APPLICABLE)
  taxRatePercent  Decimal?             @db.Decimal(9,4)
  taxAmount       Decimal?             @db.Decimal(20,6)
  lineTotal       Decimal              @db.Decimal(20,6)
  revenueAccountId String?
  projectId       String?
  departmentId    String?
  costCentreId    String?
  fundingSourceId String?
  isActive        Boolean              @default(true)

  @@unique([invoiceId, lineNumber])
  @@index([invoiceId])
  @@index([taxRuleId])
  @@map("invoice_lines")
}

model Payment {
  id             String          @id @default(cuid())
  organizationId String
  paymentNumber  String
  paymentDate    DateTime        @db.Date
  direction      PaymentDirection
  status         PaymentStatus   @default(DRAFT)
  amount         Decimal         @db.Decimal(20,6)
  currency       String          @db.Char(3)
  baseAmount     Decimal         @db.Decimal(20,6)
  exchangeRateId String?
  fxDifferenceAmount Decimal?     @db.Decimal(20,6)
  paymentMethod  PaymentMethod
  treasuryAccountId String?
  treasuryAccount   TreasuryAccount? @relation(fields: [treasuryAccountId], references: [id])
  customerId     String?
  customer       Customer?       @relation(fields: [customerId], references: [id])
  supplierId     String?
  supplier       Supplier?       @relation(fields: [supplierId], references: [id])
  supplierBankDetailId String?
  // PDF §23 anti-fraud: payment to recently-changed bank details
  supplierBankDetailWasChanged Boolean @default(false)
  accountId      String?         // GL cash/bank account
  reference      String?
  narrative      String?
  projectId      String?
  departmentId   String?
  costCentreId   String?
  fundingSourceId String?
  locationId     String?
  journalEntryId String?
  journalEntry   JournalEntry?   @relation(fields: [journalEntryId], references: [id])
  approvalRequestId String?
  submittedById  String?
  submittedAt    DateTime?
  approvedById   String?
  approvedAt     DateTime?
  processedAt    DateTime?
  completedAt    DateTime?
  failedAt       DateTime?
  failureReason  String?
  // PDF §9 reversals
  isReversal       Boolean        @default(false)
  reversalType     ReversalType?
  reversesPaymentId String?
  reversesPayment   Payment?       @relation("PaymentReversal", fields: [reversesPaymentId], references: [id])
  reversedByPaymentId String?
  reversedByPayment   Payment?     @relation("PaymentReversal")
  reasonCodeId     String?
  reasonCode       ReasonCode?    @relation(fields: [reasonCodeId], references: [id])
  isUnverified         Boolean            @default(false)
  verificationStatus   VerificationStatus @default(VERIFIED)
  documentId     String?
  document       Document?       @relation(fields: [documentId], references: [id])
  source         String?         // MANUAL|IMPORT|OFFLINE_SYNC|API
  externalReference String?
  createdById    String
  createdAt      DateTime        @default(now())
  updatedById    String?
  updatedAt      DateTime        @updatedAt
  deletedAt      DateTime?       // only while DRAFT

  allocations PaymentAllocation[]
  receipts    Receipt[]
  matches     ReconciliationMatch[]

  @@unique([organizationId, paymentNumber])
  @@index([status, paymentDate])
  @@index([direction])
  @@index([customerId])
  @@index([supplierId])
  @@index([treasuryAccountId])
  @@index([journalEntryId])
  @@index([reversesPaymentId])
  @@map("payments")
}

// PDF §16 payment allocation, partial and one-to-many
model PaymentAllocation {
  id          String          @id @default(cuid())
  paymentId   String
  payment     Payment         @relation(fields: [paymentId], references: [id], onDelete: Cascade)
  invoiceId   String?
  invoice     Invoice?        @relation(fields: [invoiceId], references: [id])
  accountId   String?         // unapplied credit account
  amount      Decimal         @db.Decimal(20,6)
  currency    String          @db.Char(3)
  baseAmount  Decimal         @db.Decimal(20,6)
  appliedAt   DateTime        @default(now())
  allocationMethod AllocationMethod @default(AUTOMATIC)
  isUnapplied Boolean         @default(false)   // on-account / unallocated
  notes       String?
  createdById String

  @@unique([paymentId, invoiceId, amount])
  @@index([invoiceId])
  @@index([paymentId])
  @@index([accountId])
  @@map("payment_allocations")
}

model Receipt {
  id             String              @id @default(cuid())
  organizationId String
  receiptNumber  String
  receiptDate    DateTime            @db.Date
  status         ReceiptStatus       @default(DRAFT)
  customerId     String?
  customer       Customer?           @relation(fields: [customerId], references: [id])
  paymentId      String?
  payment        Payment?            @relation(fields: [paymentId], references: [id])
  invoiceId      String?
  invoice        Invoice?            @relation(fields: [invoiceId], references: [id])
  currency       String              @db.Char(3)
  total          Decimal             @default(0) @db.Decimal(20,6)
  amountPaid     Decimal             @default(0) @db.Decimal(20,6)
  paymentMethod  PaymentMethod
  treasuryAccountId String?
  documentId     String?             // supporting document (PDF §8)
  document       Document?           @relation(fields: [documentId], references: [id])
  // Offline capture (PDF §58)
  capturedOffline   Boolean           @default(false)
  offlineCapturedAt DateTime?
  syncIdempotencyKey String?
  // Honesty flags - physical cash receipts are often historical/incomplete
  isUnverified         Boolean            @default(false)
  verificationStatus   VerificationStatus @default(VERIFIED)
  issuedById     String
  issuedAt       DateTime?
  voidedById     String?
  voidedAt       DateTime?
  voidReason     String?
  journalEntryId String?
  notes          String?
  createdById    String
  createdAt      DateTime            @default(now())
  updatedById    String?
  updatedAt      DateTime            @updatedAt
  deletedAt      DateTime?

  lines ReceiptLine[]

  @@unique([organizationId, receiptNumber])
  @@index([receiptDate])
  @@index([customerId])
  @@index([status])
  @@index([capturedOffline])
  @@map("receipts")
}

model ReceiptLine {
  id              String   @id @default(cuid())
  receiptId       String
  receipt         Receipt  @relation(fields: [receiptId], references: [id], onDelete: Cascade)
  lineNumber      Int
  productServiceId String?
  productService   ProductService? @relation(fields: [productServiceId], references: [id])
  description     String
  quantity        Decimal  @db.Decimal(18,6)
  unitPrice       Decimal  @db.Decimal(20,6)
  lineTotal       Decimal  @db.Decimal(20,6)
  accountId       String?

  @@unique([receiptId, lineNumber])
  @@index([receiptId])
  @@map("receipt_lines")
}

model CreditNote {
  id               String           @id @default(cuid())
  organizationId   String
  creditNoteNumber String
  invoiceId        String?
  invoice          Invoice?         @relation(fields: [invoiceId], references: [id])
  customerId       String?
  customer         Customer?        @relation(fields: [customerId], references: [id])
  creditNoteDate   DateTime         @db.Date
  status           CreditNoteStatus @default(DRAFT)
  reasonCodeId     String?
  reasonCode       ReasonCode?      @relation(fields: [reasonCodeId], references: [id])
  reason           String
  currency         String           @db.Char(3)
  subtotal         Decimal          @default(0) @db.Decimal(20,6)
  taxTotal         Decimal          @default(0) @db.Decimal(20,6)
  total            Decimal          @default(0) @db.Decimal(20,6)
  appliedAmount    Decimal          @default(0) @db.Decimal(20,6)
  journalEntryId   String?
  journalEntry     JournalEntry?    @relation(fields: [journalEntryId], references: [id])
  approvalRequestId String?
  approvedById     String?
  approvedAt       DateTime?
  issuedAt         DateTime?
  documentId       String?
  isUnverified     Boolean          @default(false)
  notes            String?
  createdById      String
  createdAt        DateTime         @default(now())
  updatedById      String?
  updatedAt        DateTime         @updatedAt
  deletedAt        DateTime?

  @@index([invoiceId])
  @@index([customerId])
  @@index([status])
  @@map("credit_notes")
}

model DebitNote {
  id               String          @id @default(cuid())
  organizationId   String
  debitNoteNumber  String
  supplierId       String?
  debitNoteDate    DateTime        @db.Date
  status           DebitNoteStatus @default(DRAFT)
  reasonCodeId     String?
  reasonCode       ReasonCode?     @relation(fields: [reasonCodeId], references: [id])
  reason           String
  currency         String          @db.Char(3)
  total            Decimal         @default(0) @db.Decimal(20,6)
  appliedAmount    Decimal         @default(0) @db.Decimal(20,6)
  journalEntryId   String?
  journalEntry     JournalEntry?   @relation(fields: [journalEntryId], references: [id])
  approvalRequestId String?
  approvedById     String?
  approvedAt       DateTime?
  documentId       String?
  notes            String?
  createdById      String
  createdAt        DateTime        @default(now())
  updatedAt        DateTime        @updatedAt
  deletedAt        DateTime?

  @@index([supplierId])
  @@index([status])
  @@map("debit_notes")
}

// ===========================================================================
// B11. DOCUMENTS  (PDF §28, §56)
// ===========================================================================

model Document {
  id             String              @id @default(cuid())
  organizationId String
  documentNumber String
  title          String
  category       DocumentCategory
  status         DocumentStatus      @default(UPLOADED)
  visibility     DocumentVisibility  @default(RESTRICTED)
  // Pluggable storage: local in dev, S3-compatible in prod (BUILD_PROMPT §3)
  storageProvider String             @default("local")
  storageKey     String
  storageBucket  String?
  fileName       String
  mimeType       String
  fileSizeBytes  Int
  checksumSha256 String
  // OCR-ready fields. OCR pipeline is Phase 3; columns exist now (PDF §28).
  ocrStatus      String              @default("NOT_RUN")
  ocrText        String?
  ocrConfidence  Decimal?            @db.Decimal(5,4)
  classificationSource       String?   // MANUAL|RULE|AI_SUGGESTED
  classificationConfidence   Decimal? @db.Decimal(5,4)
  // PDF §2 historical documents are incomplete
  isUnverified         Boolean            @default(false)
  verificationStatus   VerificationStatus @default(PENDING_VERIFICATION)
  issuedDate     DateTime?           @db.Date
  expiresAt      DateTime?           @db.Date
  expiryReminderDays Int?
  reminderSentAt DateTime?
  // PDF §28 retention & legal holds
  retentionPolicyId String?
  retentionPolicy   RetentionPolicy? @relation(fields: [retentionPolicyId], references: [id])
  retentionUntil DateTime?
  retentionAction  RetentionAction?
  isLegalHold   Boolean            @default(false)
  legalHoldReason LegalHoldReason?
  legalHoldSetById String?
  legalHoldSetAt DateTime?
  currentVersionNumber Int           @default(1)
  approvalRequestId String?
  approvedById   String?
  approvedAt     DateTime?
  notes          String?
  metadata       Json?
  uploadedById   String
  uploadedAt     DateTime            @default(now())
  // PDF §58 offline capture
  capturedOffline   Boolean           @default(false)
  syncIdempotencyKey String?
  deletedAt      DateTime?          // soft delete; BLOCKED by legal hold
  deletedById    String?
  deletedReason  String?

  versions       DocumentVersion[]
  tags           DocumentTag[]
  links          DocumentLink[]

  transactions   Transaction[]   @relation("TransactionPrimaryDocument")
  journalEntries JournalEntry[]
  payments       Payment[]
  invoices       Invoice[]
  receipts       Receipt[]
  quotations     Quotation[]
  creditNotes    CreditNote[]
  transfers      Transfer[]
  communications CommunicationLog[]
  supplierChanges SupplierBankDetailChangeRequest[]
  complianceDocs ComplianceDocument[]

  @@unique([organizationId, documentNumber])
  @@index([category, status])
  @@index([checksumSha256])
  @@index([expiresAt])
  @@index([isLegalHold])
  @@index([verificationStatus])
  @@map("documents")
}

model DocumentVersion {
  id             String    @id @default(cuid())
  documentId     String
  document       Document  @relation(fields: [documentId], references: [id], onDelete: Cascade)
  versionNumber  Int
  storageKey     String
  fileName       String
  mimeType       String
  fileSizeBytes  Int
  checksumSha256 String
  changeReason   String?
  ocrStatus      String    @default("NOT_RUN")
  ocrText        String?
  uploadedById   String
  uploadedAt     DateTime  @default(now())

  @@unique([documentId, versionNumber])
  @@index([documentId])
  @@map("document_versions")
}

model Tag {
  id             String   @id @default(cuid())
  organizationId String
  name           String
  color          String?
  createdAt      DateTime @default(now())

  documents DocumentTag[]

  @@unique([organizationId, name])
  @@map("tags")
}

model DocumentTag {
  documentId String
  document   Document @relation(fields: [documentId], references: [id], onDelete: Cascade)
  tagId      String
  tag        Tag      @relation(fields: [tagId], references: [id], onDelete: Cascade)
  taggedById String?
  taggedAt   DateTime @default(now())

  @@id([documentId, tagId])
  @@index([tagId])
  @@map("document_tags")
}

// Polymorphic link table (BUILD_PROMPT §6, PDF §28 "Transaction matching")
model DocumentLink {
  id         String             @id @default(cuid())
  documentId String
  document   Document           @relation(fields: [documentId], references: [id], onDelete: Cascade)
  entityType DocumentEntityType
  entityId   String
  linkType   String             @default("EVIDENCE") // EVIDENCE|SUPPORTING|PRIMARY|CONTRACT|AMENDMENT
  isPrimary  Boolean            @default(false)
  linkedById String
  linkedAt   DateTime           @default(now())

  project    Project?           @relation(fields: [entityId], references: [id])  // convenience when entityType=PROJECT

  @@unique([documentId, entityType, entityId, linkType])
  @@index([entityType, entityId])
  @@index([documentId])
  @@map("document_links")
}

model RetentionPolicy {
  id               String           @id @default(cuid())
  name             String           @unique
  documentCategory DocumentCategory?
  retentionMonths  Int
  action           RetentionAction  @default(ARCHIVE)
  legalBasis       String?
  isActive         Boolean          @default(true)
  createdAt        DateTime         @default(now())
  updatedAt        DateTime         @updatedAt

  documents Document[]

  @@map("retention_policies")
}

model LegalHold {
  id           String          @id @default(cuid())
  entityType   AuditEntityType
  entityId     String
  reason       LegalHoldReason
  notes        String?
  setById      String
  setAt        DateTime        @default(now())
  releasedById String?
  releasedAt   DateTime?
  releaseReason String?
  isActive     Boolean         @default(true)

  @@index([entityType, entityId, isActive])
  @@map("legal_holds")
}

// ===========================================================================
// B12. APPROVAL WORKFLOW ENGINE  (PDF §3.1, §8, §23, §63, §64)
// ===========================================================================

model ApprovalPolicy {
  id             String              @id @default(cuid())
  organizationId String
  name           String
  entityType     ApprovalEntityType
  description    String?
  isActive       Boolean             @default(true)
  isDefault      Boolean             @default(false)
  priority       Int                 @default(100)   // lower = evaluated first
  version        Int                 @default(1)
  // Amount/currency thresholds that SELECT this policy
  minAmount      Decimal?            @db.Decimal(20,6)
  maxAmount      Decimal?            @db.Decimal(20,6)
  currency       String?             @db.Char(3)
  conditions     Json?               // over-budget, restricted funding, FX, ...
  // PDF §64 "The CEO shall approve final close where configured"
  requiresFinalApprover Boolean      @default(true)
  finalApproverRoleId String?
  finalApproverRole   Role?         @relation(fields: [finalApproverRoleId], references: [id])
  // Segregation of duties
  forbidSelfApproval   Boolean       @default(true)
  forbidApproverAsPreparer Boolean  @default(true)
  activeFrom      DateTime?
  inactiveTo      DateTime?
  createdById     String
  createdAt       DateTime            @default(now())
  updatedById     String?
  updatedAt       DateTime            @updatedAt
  deletedAt       DateTime?

  steps ApprovalPolicyStep[]
  requests ApprovalRequest[]

  @@unique([organizationId, name, version])
  @@index([entityType, isActive])
  @@map("approval_policies")
}

model ApprovalPolicyStep {
  id             String               @id @default(cuid())
  policyId       String
  policy         ApprovalPolicy       @relation(fields: [policyId], references: [id], onDelete: Cascade)
  stepOrder      Int
  name           String
  type           ApprovalStepType     @default(APPROVAL)
  assigneeType   ApprovalAssigneeType @default(ROLE)
  assigneeRoleId String?
  assigneeRole   Role?                @relation(fields: [assigneeRoleId], references: [id])
  assigneeUserId String?
  resolutionMode ResolutionMode       @default(ANY)
  minApprovals   Int                  @default(1)
  conditions     Json?                // evaluated against request payload
  slaHours       Int?
  // Segregation of duties
  excludePreparer Boolean             @default(true)
  excludeSelf     Boolean             @default(true)
  onReject       String               @default("TERMINATE") // TERMINATE|RETURN_TO_PREVIOUS
  isRequired     Boolean              @default(true)
  escalateAfterHours Int?
  escalateToUserId   String?

  @@unique([policyId, stepOrder])
  @@index([policyId])
  @@map("approval_policy_steps")
}

model ApprovalRequest {
  id              String                 @id @default(cuid())
  organizationId  String
  requestNumber   String
  entityType      ApprovalEntityType
  entityId        String
  entityLabel     String?
  entityAmount    Decimal?               @db.Decimal(20,6)
  currency        String?                @db.Char(3)
  policyId        String?
  policy          ApprovalPolicy?        @relation(fields: [policyId], references: [id])
  policySnapshot  Json                   // FROZEN copy - policy edits never rewrite history
  status          ApprovalRequestStatus  @default(PENDING)
  outcome         ApprovalOutcome        @default(PENDING)
  currentStepOrder Int?
  context         Json                   // project, dept, fundingSource, overBudget, sodFlags...
  requestedById   String
  requestedAt     DateTime               @default(now())
  completedAt     DateTime?
  dueAt           DateTime?
  expiresAt       DateTime?
  cancelledById   String?
  cancelledAt     DateTime?
  cancellationReason String?
  // Final authority (PDF §3.1: CEO remains final authority)
  finalApproverId String?
  finalApprovedAt DateTime?
  finalApproverNotes String?

  steps     ApprovalStepInstance[]
  decisions ApprovalDecisionRecord[]

  journalEntries        JournalEntry[]
  transactions          Transaction[]
  invoices              Invoice[]
  payments              Payment[]
  receipts              Receipt[]
  quotations            Quotation[]
  budgets               Budget[]
  budgetRevisions       BudgetRevision[]
  creditNotes           CreditNote[]
  documents             Document[]
  supplierBankChanges   SupplierBankDetailChangeRequest[]
  reconAdjustments      ReconciliationAdjustment[]
  importBatches         ImportBatch[]
  reconciliations       ReconciliationSession[]
  anomalyFlags          AnomalyFlag[]

  @@unique([organizationId, requestNumber])
  @@index([entityType, entityId])
  @@index([status, requestedAt])
  @@index([entityType, status])
  @@map("approval_requests")
}

model ApprovalStepInstance {
  id               String                 @id @default(cuid())
  requestId        String
  request          ApprovalRequest        @relation(fields: [requestId], references: [id], onDelete: Cascade)
  stepOrder        Int
  stepName         String
  type             ApprovalStepType       @default(APPROVAL)
  status           ApprovalRequestStatus  @default(PENDING)
  // Eligible approvers RESOLVED at activation time (delegations applied here)
  eligibleUserIds  String[]
  eligibleRoleIds  String[]
  resolutionMode   ResolutionMode         @default(ANY)
  minApprovals     Int                    @default(1)
  approvalsReceived Int                   @default(0)
  dueAt            DateTime?
  activatedAt      DateTime?
  completedAt      DateTime?
  slaBreached      Boolean                @default(false)
  escalatedAt      DateTime?

  decisions ApprovalDecisionRecord[]

  @@unique([requestId, stepOrder])
  @@index([status, dueAt])
  @@map("approval_step_instances")
}

model ApprovalDecisionRecord {
  id             String              @id @default(cuid())
  requestId      String
  request        ApprovalRequest     @relation(fields: [requestId], references: [id], onDelete: Cascade)
  stepInstanceId String?
  stepInstance   ApprovalStepInstance? @relation(fields: [stepInstanceId], references: [id], onDelete: SetNull)
  stepOrder      Int
  decision       ApprovalDecision
  decidedById    String
  decidedByName  String              // denormalised - survives user deletion
  decidedAt      DateTime            @default(now())
  comments       String?
  // Delegation applied at decision time (PDF §4)
  viaDelegationId String?
  delegationId   String?
  delegationSnapshot Json?
  // Segregation-of-duties evidence
  isSelfApproval Boolean             @default(false)
  sodCheckPassed Boolean             @default(true)
  sodFlags       String[]            @default([])
  actingOnBehalfOfId String?
  mfaVerified    Boolean             @default(false)
  ipAddress      String?
  userAgent      String?

  @@index([requestId, stepOrder])
  @@index([decidedById])
  @@map("approval_decision_records")
}

// ===========================================================================
// B13. AUDIT TRAIL  (PDF §54) - append-only, tamper-evident
// ===========================================================================

model AuditLog {
  id             String         @id @default(cuid())
  // ---- Hash chain (tamper-evident, PDF §54) ----
  sequence       BigInt         @unique @default(autoincrement())
  previousHash   String?
  entryHash      String         @unique
  signature      String?        // HMAC over entryHash with a rotating key
  // ---- Who / what / when ----
  organizationId String
  actorId        String?
  actorName      String?        // denormalised
  actorRoleCodes String[]
  action         AuditAction
  entityType     AuditEntityType
  entityId       String?
  entityLabel    String?
  description    String?
  // ---- Change detail ----
  changes        Json?          // { field: { from, to } }
  metadata       Json?
  // ---- Context ----
  ipAddress      String?
  userAgent      String?
  requestId      String?
  sessionId      String?
  channel        String         @default("WEB")   // WEB|API|CLI|SYSTEM|SYNC
  result         AuditResult    @default(SUCCESS)
  errorMessage   String?
  occurredAt     DateTime       @default(now())  // event time
  recordedAt     DateTime       @default(now())  // write time

  @@index([organizationId, occurredAt])
  @@index([entityType, entityId])
  @@index([actorId, occurredAt])
  @@index([action, occurredAt])
  @@index([requestId])
  @@map("audit_logs")
}

// Daily chained checkpoints - enables fast chain verification
model AuditChainCheckpoint {
  id          String   @id @default(cuid())
  chainDate   DateTime @db.Date
  firstSequence BigInt
  lastSequence  BigInt
  firstHash   String
  lastHash    String
  entryCount  Int
  verifiedAt  DateTime?
  verifiedById String?
  status      String   @default("OPEN")   // OPEN|SEALED|VERIFIED|BROKEN
  notes       String?
  createdAt   DateTime @default(now())

  @@unique([chainDate])
  @@index([status])
  @@map("audit_chain_checkpoints")
}

model SecurityEvent {
  id             String                 @id @default(cuid())
  organizationId String
  eventType      SecurityEventType
  severity       SecurityEventSeverity
  userId         String?
  ipAddress      String?
  userAgent      String?
  deviceFingerprint String?
  description    String
  context        Json?
  resolvedAt     DateTime?
  resolvedById   String?
  resolutionNotes String?
  occurredAt     DateTime               @default(now())

  @@index([eventType, occurredAt])
  @@index([severity, resolvedAt])
  @@index([userId])
  @@map("security_events")
}
```

### 3.7 Models — Notifications, tax & compliance, anomaly, close, import, infrastructure

```prisma
// ===========================================================================
// B14. NOTIFICATIONS  (PDF §46 - Phase 1 minimum: in-app + email)
// ===========================================================================

model Notification {
  id             String                 @id @default(cuid())
  organizationId String
  userId         String
  category       NotificationCategory
  severity       NotificationSeverity   @default(INFO)
  channel        NotificationChannel
  title          String
  body           String
  actionUrl      String?
  entityType     String?
  entityId       String?
  status         NotificationStatus     @default(PENDING)
  sentAt         DateTime?
  deliveredAt    DateTime?
  readAt         DateTime?
  failedAt       DateTime?
  failureReason  String?
  dedupeKey      String?                // prevents duplicate notification storms
  createdAt      DateTime               @default(now())

  @@unique([userId, dedupeKey])
  @@index([userId, status, createdAt])
  @@index([organizationId, category])
  @@index([status, createdAt])
  @@map("notifications")
}

model NotificationPreference {
  id          String               @id @default(cuid())
  userId      String
  category    NotificationCategory
  inAppEnabled Boolean             @default(true)
  emailEnabled Boolean             @default(true)
  // SMS architected (PDF §46) but Phase 1 delivery is in-app + email minimum.
  smsEnabled  Boolean              @default(false)
  quietHoursStart String?          // e.g. "20:00"
  quietHoursEnd   String?
  digestFrequency String            @default("IMMEDIATE") // IMMEDIATE|DAILY|WEEKLY
  updatedAt    DateTime             @updatedAt

  @@unique([userId, category])
  @@map("notification_preferences")
}

// ===========================================================================
// B15. TAX & COMPLIANCE  (PDF §32, §42) - FULLY CONFIGURABLE, NO HARDCODE
// ===========================================================================

// PDF §32 VERBATIM: "Tax rules must be configurable and verified against
// current Tanzanian requirements."
// => rates, thresholds, filing deadlines, account mappings and applicability
//    are DATA. Zero Tanzanian tax values appear anywhere in application code.
//    Legal/accountant verification is tracked as an explicit field.
model TaxRule {
  id             String            @id @default(cuid())
  organizationId String
  code           String
  name           String
  type           TaxRuleType
  jurisdiction   String                       // configurable, e.g. country/region code
  // Rate stored as a percentage DECIMAL - value entered by an authorised user
  ratePercent    Decimal?         @db.Decimal(9,6)
  isInclusive    Boolean          @default(false)
  calculationBasis TaxCalculationBasis @default(NOT_APPLICABLE)
  // Applicability - critical pre-registration (PDF §2)
  appliesWhenOrganizationRegistered Boolean @default(false)
  effectiveFrom  DateTime         @db.Date
  effectiveTo    DateTime?        @db.Date
  isActive       Boolean          @default(true)
  // GL mapping
  payableAccountId  String?
  payableAccount     Account?       @relation(fields: [payableAccountId], references: [id])
  receivableAccountId String?
  // Verification tracking
  verifiedByProfessionalOn DateTime?
  verifiedByProfessionalName String?
  verificationReference String?
  isVerified     Boolean          @default(false)
  // Round-off handling
  roundingMode   String           @default("HALF_UP")
  minTaxableAmount Decimal?       @db.Decimal(20,6)
  exemptionThreshold Decimal?     @db.Decimal(20,6)
  notes          String?
  createdById    String
  createdAt      DateTime         @default(now())
  updatedById    String?
  updatedAt      DateTime         @updatedAt
  archivedAt     DateTime?

  invoiceLines      InvoiceLine[]
  quotationLines    QuotationLine[]
  products          ProductService[]
  journalLines      JournalLine[]
  obligations        TaxObligation[]
  payments           TaxPayment[]

  @@unique([organizationId, code])
  @@index([type, isActive])
  @@index([effectiveFrom, effectiveTo])
  @@map("tax_rules")
}

model TaxObligation {
  id             String               @id @default(cuid())
  organizationId String
  taxRuleId      String?
  taxRule        TaxRule?             @relation(fields: [taxRuleId], references: [id])
  description    String
  period         TaxObligationPeriod  @default(MONTHLY)
  periodStart    DateTime             @db.Date
  periodEnd      DateTime             @db.Date
  direction      TaxDirection
  status         TaxObligationStatus  @default(PENDING)
  // NOT_APPLICABLE is the correct pre-registration default (PDF §2)
  filingDueDate  DateTime?            @db.Date
  filingReference String?
  filedAt        DateTime?
  taxableAmount  Decimal              @default(0) @db.Decimal(20,6)
  taxAmount      Decimal              @default(0) @db.Decimal(20,6)
  currency       String               @db.Char(3)
  partyId        String?               // e.g. supplier for withholding
  paymentId      String?
  payment        Payment?             @relation(fields: [paymentId], references: [id])
  complianceDocumentId String?
  complianceDocument   ComplianceDocument? @relation(fields: [complianceDocumentId], references: [id])
  notes          String?
  createdById    String
  createdAt      DateTime             @default(now())
  updatedAt      DateTime             @updatedAt

  payments TaxPayment[]

  @@index([status, filingDueDate])
  @@index([periodStart, periodEnd])
  @@index([taxRuleId])
  @@map("tax_obligations")
}

model TaxPayment {
  id          String   @id @default(cuid())
  taxRuleId   String?
  taxRule     TaxRule? @relation(fields: [taxRuleId], references: [id])
  obligationId String?
  obligation  TaxObligation? @relation(fields: [obligationId], references: [id])
  paidAt      DateTime @db.Date
  amount      Decimal  @db.Decimal(20,6)
  currency    String   @db.Char(3)
  paymentId   String?
  reference   String?
  documentId  String?
  journalEntryId String?
  notes       String?
  createdById String
  createdAt   DateTime @default(now())

  @@index([obligationId])
  @@index([paidAt])
  @@map("tax_payments")
}

// PDF §42 registration, licences, permits, certifications, memberships
model Credential {
  id             String            @id @default(cuid())
  organizationId String
  type           CredentialType
  title          String
  issuingAuthority String?
  registrationNumber String?
  issuedDate     DateTime?         @db.Date
  expiryDate     DateTime?         @db.Date
  responsibleUserId String?
  cost           Decimal?          @db.Decimal(20,6)
  currency       String?           @db.Char(3)
  status         CredentialStatus  @default(PENDING)
  // NOT_APPLICABLE for pre-registration credentials (PDF §2)
  notApplicableReason String?
  renewalReminderDays Int?
  lastReminderAt DateTime?
  supplierId     String?
  complianceDocumentId String?
  complianceDocument   ComplianceDocument? @relation(fields: [complianceDocumentId], references: [id])
  notes          String?
  createdById    String
  createdAt      DateTime          @default(now())
  updatedAt      DateTime          @updatedAt

  @@index([type, status])
  @@index([expiryDate])
  @@map("credentials")
}

model ComplianceDocument {
  id             String   @id @default(cuid())
  organizationId String
  credentialId   String?
  credential     Credential? @relation(fields: [credentialId], references: [id])
  taxObligationId String?
  taxObligation  TaxObligation? @relation(fields: [taxObligationId], references: [id])
  documentId     String
  document       Document @relation(fields: [documentId], references: [id])
  title          String
  issuedDate     DateTime? @db.Date
  expiryDate     DateTime? @db.Date
  createdById    String
  createdAt      DateTime  @default(now())

  @@unique([documentId])
  @@index([expiryDate])
  @@map("compliance_documents")
}

// ===========================================================================
// B16. ANOMALY / FRAUD DETECTION  (PDF §65 - FLAG ONLY, NEVER DECIDE)
// ===========================================================================

model AnomalyFlag {
  id             String          @id @default(cuid())
  organizationId String
  anomalyType    AnomalyType
  severity       AnomalySeverity
  status         AnomalyStatus   @default(OPEN)
  entityType     AuditEntityType
  entityId       String
  entityLabel    String?
  // PDF §65: AI flags records, NEVER accuses people.
  // There is deliberately NO accusedUserId column.
  detectedBy     String          @default("RULE_ENGINE")  // RULE_ENGINE|AI_SUGGESTED|HUMAN
  detectionRule  String?
  confidence     Int?
  description    String
  evidence       Json?
  // A flag alone MUST NOT alter money. A named human must acknowledge first.
  blocksAction   Boolean         @default(false)
  acknowledgedById String?
  acknowledgedAt DateTime?
  dismissedById  String?
  dismissedAt    DateTime?
  dismissalReason String?
  confirmedById  String?
  confirmedAt    DateTime?
  resolvedAt     DateTime?
  resolutionNotes String?
  approvalRequestId String?
  approvalRequest   ApprovalRequest? @relation(fields: [approvalRequestId], references: [id])
  createdAt      DateTime        @default(now())
  updatedAt      DateTime        @updatedAt

  @@index([status, severity])
  @@index([entityType, entityId])
  @@index([organizationId, anomalyType])
  @@map("anomaly_flags")
}

// ===========================================================================
// B17. FINANCIAL CLOSE  (PDF §64)
// ===========================================================================

model FinancialClose {
  id             String       @id @default(cuid())
  organizationId String
  closeReference String
  periodId       String
  period         FinancialPeriod @relation(fields: [periodId], references: [id])
  status         String       @default("IN_PROGRESS") // IN_PROGRESS|AWAITING_SIGNOFF|CLOSED|ABANDONED
  openedById     String
  openedAt       DateTime     @default(now())
  closedById     String?
  closedAt       DateTime?
  // PDF §64: "The CEO shall approve final close where configured."
  requiresCeoSignOff Boolean @default(true)
  signOffApprovalRequestId String?
  signOffById   String?
  signOffAt     DateTime?
  signOffNotes  String?
  financialStatementSnapshot Json?   // frozen statement figures at close
  summary       String?
  deferredItems Json?               // items waived/deferred with reasons
  createdAt     DateTime     @default(now())
  updatedAt     DateTime     @updatedAt

  items CloseChecklistItem[]

  @@unique([organizationId, closeReference])
  @@index([periodId])
  @@index([status])
  @@map("financial_closes")
}

model CloseChecklistItem {
  id          String          @id @default(cuid())
  closeId     String
  close       FinancialClose  @relation(fields: [closeId], references: [id], onDelete: Cascade)
  key         CloseItemKey
  label       String
  status      CloseItemStatus @default(NOT_STARTED)
  automated   Boolean         @default(false)   // auto-checked vs manually confirmed
  checkResult Json?           // figures supporting PASSED/FAILED
  isBlocking  Boolean         @default(true)    // blocking items prevent close
  checkedById String?
  checkedAt   DateTime?
  waiverReason String?
  waivedById  String?
  waivedAt    DateTime?
  periodId    String?
  period      FinancialPeriod? @relation(fields: [periodId], references: [id])
  notes       String?
  createdAt   DateTime        @default(now())
  updatedAt   DateTime        @updatedAt

  @@unique([closeId, key])
  @@index([status, isBlocking])
  @@map("close_checklist_items")
}

// ===========================================================================
// B18. IMPORT / MIGRATION  (PDF §52) - the 7-stage gated pipeline
// ===========================================================================

model ImportBatch {
  id             String             @id @default(cuid())
  organizationId String
  entityType     String             // CUSTOMER|SUPPLIER|TRANSACTION|INVOICE|OPENING_BALANCE|BANK_STATEMENT
  importType     ImportSource       @default(CSV)
  fileName       String
  storageKey     String?
  fileHash       String
  status         ImportBatchStatus  @default(UPLOADED)
  // PDF §52 preserves original info + source + import date + verification
  // status + migration history.
  source         String?            // where the data came from
  sourceReference String?
  importedById   String
  importedAt     DateTime?          // import date
  migratedFromSystem String?        // migration history
  mappingId      String?
  totalRows      Int                @default(0)
  validRows      Int                @default(0)
  errorRows      Int                @default(0)
  duplicateRows  Int                @default(0)
  importedRows   Int                @default(0)
  approvalRequestId String?
  approvalRequest   ApprovalRequest? @relation(fields: [approvalRequestId], references: [id])
  approvedById   String?
  approvedAt     DateTime?
  rolledBackAt   DateTime?
  rollbackReason String?
  notes          String?
  createdAt      DateTime           @default(now())
  updatedAt      DateTime           @updatedAt

  rows              ImportRow[]
  errors            ImportError[]
  fieldMappings     ImportMapping[]
  journalEntries    JournalEntry[]
  transactions      Transaction[]
  openingBalances   OpeningBalance[]
  statementImports  BankStatementImport[]

  @@unique([organizationId, fileHash])
  @@index([entityType, status])
  @@index([importedById])
  @@map("import_batches")
}

// Staging rows: UPLOAD -> MAP -> VALIDATE -> PREVIEW -> DEDUPE -> APPROVE -> IMPORT
model ImportRow {
  id           String       @id @default(cuid())
  batchId      String
  batch        ImportBatch  @relation(fields: [batchId], references: [id], onDelete: Cascade)
  rowNumber    Int
  rawData      Json         // PDF §52: ORIGINAL INFORMATION preserved verbatim
  mappedData   Json?
  normalizedData Json?
  fingerprint  String       // duplicate detection
  isDuplicate  Boolean      @default(false)
  duplicateOfRowId String?
  duplicateReason    String?
  validationStatus String   @default("PENDING") // PENDING|VALID|ERROR|WARNING|SKIPPED
  validationErrors Json?
  previewRendered Boolean    @default(false)
  approved     Boolean      @default(false)
  importedEntityType String?
  importedEntityId   String?
  importedAt    DateTime?
  // Honest provenance (PDF §52)
  verificationStatus VerificationStatus @default(PENDING_VERIFICATION)
  notes        String?
  createdAt    DateTime     @default(now())

  errors ImportError[]

  @@unique([batchId, rowNumber])
  @@index([batchId, validationStatus])
  @@index([fingerprint])
  @@index([isDuplicate])
  @@map("import_rows")
}

model ImportMapping {
  id          String   @id @default(cuid())
  batchId     String
  batch       ImportBatch @relation(fields: [batchId], references: [id], onDelete: Cascade)
  sourceField String
  targetField String
  targetModel String?
  dataType    String?
  transform   String?   // NONE|TRIM|UPPER|LOWER|PARSE_DATE|PARSE_DECIMAL|...
  isRequired  Boolean  @default(false)
  sampleValue String?

  @@unique([batchId, sourceField])
  @@map("import_mappings")
}

model ImportError {
  id          String          @id @default(cuid())
  batchId     String
  batch       ImportBatch     @relation(fields: [batchId], references: [id], onDelete: Cascade)
  rowId       String?
  row         ImportRow?      @relation(fields: [rowId], references: [id], onDelete: SetNull)
  statementImportId String?
  statementImport   BankStatementImport? @relation(fields: [statementImportId], references: [id], onDelete: Cascade)
  statementLineId   String?
  rowNumber   Int?
  errorType   ImportErrorType
  field       String?
  message     String
  rawValue    String?
  resolved    Boolean         @default(false)
  resolvedById String?
  resolvedAt  DateTime?
  resolutionNotes String?
  createdAt   DateTime        @default(now())

  @@index([batchId, resolved])
  @@index([errorType])
  @@map("import_errors")
}

// ===========================================================================
// B19. INFRASTRUCTURE: idempotency, API, webhooks, backups, PWA sync
// ===========================================================================

// PDF §59 "Idempotency"
model IdempotencyKey {
  id             String   @id @default(cuid())
  key            String
  organizationId String
  route          String
  requestHash    String
  actorId        String?
  responseStatus Int?
  responseBody   Json?
  inFlight       Boolean  @default(true)
  createdAt      DateTime @default(now())
  expiresAt      DateTime

  @@unique([key, route])
  @@index([organizationId, createdAt])
  @@index([expiresAt])
  @@map("idempotency_keys")
}

model ApiKey {
  id             String       @id @default(cuid())
  organizationId String
  name           String
  prefix         String
  keyHash        String
  scopes         String[]
  status         ApiKeyStatus @default(ACTIVE)
  lastUsedAt     DateTime?
  expiresAt      DateTime?
  rateLimitPerMinute Int?
  allowedIps     String[]
  createdById    String
  createdAt      DateTime     @default(now())
  revokedAt      DateTime?
  revokedById    String?

  @@unique([prefix])
  @@index([organizationId, status])
  @@map("api_keys")
}

model Webhook {
  id             String   @id @default(cuid())
  organizationId String
  name           String
  targetUrl      String
  eventTypes     String[]
  secretEnc      String
  isActive       Boolean  @default(true)
  failureCount   Int      @default(0)
  lastSuccessAt  DateTime?
  lastFailureAt  DateTime?
  createdById    String
  createdAt      DateTime @default(now())

  deliveries WebhookDelivery[]

  @@index([organizationId, isActive])
  @@map("webhooks")
}

model WebhookDelivery {
  id           String        @id @default(cuid())
  webhookId    String
  webhook      Webhook       @relation(fields: [webhookId], references: [id], onDelete: Cascade)
  eventType    String
  payload      Json
  status       WebhookStatus @default(PENDING)
  attemptCount Int           @default(0)
  responseStatus Int?
  responseBody String?
  nextRetryAt  DateTime?
  deliveredAt  DateTime?
  createdAt    DateTime      @default(now())

  @@index([webhookId, status])
  @@index([status, nextRetryAt])
  @@map("webhook_deliveries")
}

// PDF §57 backup & disaster recovery
model BackupRun {
  id             String       @id @default(cuid())
  organizationId String
  type           BackupType
  status         BackupStatus @default(SCHEDULED)
  storageLocation String      // multiple backup locations (PDF §57)
  storageProvider String
  fileName       String?
  sizeBytes      BigInt?
  checksum       String?
  encryptionUsed Boolean      @default(true)
  startedAt      DateTime?
  completedAt    DateTime?
  verifiedAt     DateTime?
  verifiedById   String?
  verificationResult String?
  retentionUntil DateTime?
  restoreTestedAt DateTime?
  restoreTestResult String?
  notes          String?
  createdAt      DateTime     @default(now())

  @@index([organizationId, status])
  @@index([status, startedAt])
  @@map("backup_runs")
}

// PDF §58 offline queue - allowlisted actions only
model SyncQueueItem {
  id              String         @id @default(cuid())
  clientUserId    String
  idempotencyKey  String         @unique   // duplicate prevention (PDF §58)
  actionType      SyncActionType
  entityType      String?
  clientPayload   Json
  status          SyncStatus     @default(QUEUED)
  serverEntityId  String?
  conflictType    String?
  conflictData    Json?
  resolutionStrategy String?      // CLIENT_WINS|SERVER_WINS|MANUAL
  attempts        Int            @default(0)
  lastAttemptAt   DateTime?
  syncedAt        DateTime?
  errorMessage    String?
  createdAt       DateTime       @default(now())
  updatedAt       DateTime       @updatedAt

  @@index([clientUserId, status])
  @@index([status, createdAt])
  @@map("sync_queue_items")
}
```

### 3.8 Schema notes, invariants and database-level guards

These are **not** expressible in Prisma and ship as hand-written SQL migrations. They are the backstop that makes the invariants survive a buggy service layer.

1. **Immutability trigger.** `BEFORE UPDATE OR DELETE` on `journal_entries` raises an exception when `OLD.status IN ('POSTED','LOCKED')` unless the session variable `app.allow_locked_write = 'true'` is set (set only inside reversal/adjustment service functions). Same guard on `transactions`.
2. **Period-lock trigger.** Posting a `journal_entry` whose `period_id` resolves to a period with `status IN ('LOCKED','CLOSED')` raises an exception. Reopening requires an approved `ApprovalRequest` of type `PERIOD_REOPEN`, and increments `reopen_count` — audited, never silent.
3. **Balance trigger.** `BEFORE INSERT OR UPDATE` on `journal_entries` verifies `total_debit = total_credit` and recomputes totals from `journal_lines`.
4. **Audit append-only trigger.** `BEFORE UPDATE OR DELETE` on `audit_logs` raises unconditionally. `REVOKE UPDATE, DELETE ON audit_logs FROM app_user` as well — defence in depth.
5. **Audit hash chain.** `entryHash = sha256(previousHash ‖ sequence ‖ actorId ‖ action ‖ entityType ‖ entityId ‖ changes ‖ occurredAt)`, plus an HMAC signature with a key rotated per period. Chain verification is a scheduled job; `AuditChainCheckpoint` records daily seals so verification is incremental.
6. **Document soft-delete guard.** Deletion is blocked while `is_legal_hold = true`, and any deletion with `retentionAction = 'DELETE'` requires an approved request.
7. **Tenant isolation.** `organizationId` on every business table plus a Prisma client extension that injects the filter; no query may opt out.
8. **Numbering.** `entry_number`, `transaction_number`, `invoice_number`, etc. use a per-organization, per-year sequence with gap detection (a gap is logged to the audit trail as `SECURITY_EVENT`).
9. **Soft delete only.** Master data, customers, suppliers, accounts and projects are soft-deleted. Hard delete is permitted only for `ImportRow`, `Notification`, `Session` and `IdempotencyKey` after retention expiry.

---

## 4. Folder Structure

```
bleca-finance/
├── prisma/
│   ├── schema.prisma
│   ├── migrations/                     # versioned + reviewed
│   ├── seed.ts                         # CoA seed (incl. PDF §7 dormant accounts), roles, permissions
│   └── raw/
│       ├── immutability_triggers.sql
│       ├── period_lock_triggers.sql
│       ├── balance_trigger.sql
│       ├── audit_append_only.sql
│       └── hash_chain.sql
│
├── src/
│   ├── app/
│   │   ├── (auth)/
│   │   │   ├── login/page.tsx
│   │   │   ├── mfa-verify/page.tsx
│   │   │   ├── forgot-password/page.tsx
│   │   │   └── reset-password/page.tsx
│   │   ├── (app)/                      # authenticated shell + RBAC guard
│   │   │   ├── layout.tsx              # nav, notifications bell, user menu
│   │   │   ├── dashboard/ceo/page.tsx
│   │   │   ├── dashboard/finance/page.tsx
│   │   │   ├── accounting/
│   │   │   │   ├── chart-of-accounts/
│   │   │   │   ├── journal-entries/            # list / [id] / new / reverse
│   │   │   │   ├── general-ledger/
│   │   │   │   ├── trial-balance/
│   │   │   │   └── opening-balances/
│   │   │   ├── transactions/                   # list / [id] / new / [id]/adjust / [id]/reverse
│   │   │   ├── treasury/
│   │   │   │   ├── cash/  bank/  mobile-money/  gateways/
│   │   │   │   ├── accounts/  transfers/
│   │   │   │   ├── statement-import/           # upload -> map -> validate -> preview -> dedupe
│   │   │   │   └── reconciliation/             # sessions / [id] workbench / exceptions / reports
│   │   │   ├── budgets/                        # list / [id] / revisions / transfers / scenarios
│   │   │   ├── customers/  suppliers/
│   │   │   │   └── suppliers/[id]/bank-details # PDF §23 controlled change
│   │   │   ├── sales/
│   │   │   │   ├── quotations/  invoices/  payments/  receipts/
│   │   │   │   └── credit-notes/  debit-notes/
│   │   │   ├── documents/                      # library / [id] / upload / search
│   │   │   ├── approvals/                      # inbox / [id] / policies / history
│   │   │   ├── periods/                        # list / [id] / close / reopen
│   │   │   ├── close/                          # checklist / [id]
│   │   │   ├── reports/                        # registry + per-report routes
│   │   │   ├── master-data/                    # org / locations / departments /
│   │   │   │                                    # cost-centres / projects / funding-sources /
│   │   │   │                                    # currencies / rates / reason-codes
│   │   │   ├── tax-compliance/                 # rules / obligations / filings / credentials
│   │   │   ├── admin/
│   │   │   │   ├── users/  roles/  delegations/  access-reviews/
│   │   │   │   ├── audit-trail/                # queryable, permission-restricted
│   │   │   │   ├── imports/
│   │   │   │   ├── anomalies/
│   │   │   │   ├── security-events/
│   │   │   │   └── backups/
│   │   │   └── settings/
│   │   ├── api/v1/
│   │   │   ├── auth/  transactions/  journal-entries/  invoices/  payments/
│   │   │   ├── receipts/  documents/  approvals/  customers/  suppliers/
│   │   │   ├── budgets/  accounts/  reports/  search/
│   │   │   └── webhooks/                       # inbound integration receiver
│   │   ├── offline/                            # offline fallback shell
│   │   ├── manifest.ts  sw.ts (service worker source)
│   │   └── error.tsx  not-found.tsx  global-error.tsx
│   │
│   ├── lib/                                    # ===== KERNEL =====
│   │   ├── kernel/index.ts                     # the ONLY sanctioned kernel surface
│   │   ├── accounting/
│   │   │   ├── posting.ts                      # balance + period + SOD enforcement
│   │   │   ├── ledger.ts  balances.ts  trial-balance.ts
│   │   │   ├── reversals.ts  adjustments.ts
│   │   │   ├── financial-statements.ts
│   │   │   ├── numbering.ts
│   │   │   └── __tests__/
│   │   ├── periods/          (open/close/lock/reopen/sign-off)
│   │   ├── approvals/        (engine: policies, evaluation, delegation, SOD)
│   │   ├── rbac/             (permissions, scope resolution, authorize(), step-up)
│   │   ├── audit/            (writer, hash chain, verifier, query filters)
│   │   ├── documents/        (pluggable storage: local | s3, signed URLs, scan hook)
│   │   ├── fx/               (rate lookup, conversion, difference handling)
│   │   ├── dimensions/       (project/dept/cost centre/location/funding source)
│   │   ├── notifications/    (in-app + email dispatch, preferences, dedupe)
│   │   ├── tax/              (config-driven calculation; NO hardcoded rates)
│   │   ├── money/            (Decimal helpers, rounding, currency minor units)
│   │   ├── workflow/         (transaction state machine)
│   │   ├── imports/          (7-stage pipeline, mapping, dedupe, error queue)
│   │   ├── reconciliation/   (matching engine)
│   │   ├── budgets/          (availability, guard, revisions, transfers)
│   │   ├── reports/          (registry, query builders, PDF/XLSX/CSV renderers)
│   │   ├── exports/          (permission-aware, logged)
│   │   ├── anomaly/          (rule engine + AI suggestion adapter, flag-only)
│   │   ├── search/           (permission-aware global search)
│   │   ├── api/              (versioning, auth, rate limit, idempotency, errors, retries)
│   │   ├── db/               (prisma client, tenant extension, tx helper)
│   │   ├── auth/             (session, password, TOTP, lockout, policy loader)
│   │   ├── i18n/             (English-only strings, ready for Swahili)
│   │   └── observability/    (structured logging, metrics, tracing hooks)
│   │
│   ├── modules/
│   │   ├── module-registry.ts
│   │   ├── auth/         { server/, components/, schema/ }
│   │   ├── users-roles/  { server/, components/ }
│   │   ├── dashboard/    { server/, components/ }
│   │   ├── coa/          { server/, components/ }
│   │   ├── journal/      { server/, components/ }
│   │   ├── ledger/       { server/, components/ }
│   │   ├── transactions/ { server/, components/ }
│   │   ├── treasury/     { server/, components/ }
│   │   ├── statement-import/
│   │   ├── reconciliation/
│   │   ├── budgets/
│   │   ├── customers/    { server/, components/ }
│   │   ├── suppliers/
│   │   ├── quotations/   invoices/   payments/   receipts/
│   │   ├── documents/
│   │   ├── approvals/
│   │   ├── periods/      close/
│   │   ├── reports/      { server/, renderers/ }
│   │   ├── audit-trail/
│   │   ├── master-data/
│   │   ├── tax-compliance/
│   │   ├── imports/
│   │   ├── anomaly/
│   │   ├── notifications/
│   │   ├── search/
│   │   └── admin/
│   │
│   ├── components/          # shared UI only (ui/, layout/, charts/, tables/, forms/)
│   ├── styles/
│   ├── tests/
│   │   ├── unit/            # colocated __tests__ + pure-domain suites
│   │   ├── integration/     # DB-backed, posting/period/reconciliation invariants
│   │   ├── e2e/             # Playwright: auth, transaction lifecycle, approval,
│   │   │                    # posting, reversal, reconciliation, close
│   │   ├── fixtures/        # factories + deterministic seed (incl. the TZS 3.9M bootcamp case)
│   │   └── helpers/
│   └── server/
│
├── docs/
│   ├── architecture.md  schema.md  security.md  data-protection.md (legal-review flagged)
│   ├── runbooks/  { backup-restore.md, period-close.md, period-reopen.md,
│   │                incident-response.md, user-access-review.md, rollback.md }
│   ├── api/       { openapi.yaml, versioning.md, webhooks.md }
│   ├── testing.md  ci-cd.md  contribution.md
│   └── decisions/ { ADRs }
│
├── .github/workflows/  { ci.yml, security.yml, release.yml }
├── e2e/                { playwright.config.ts, specs/ }
├── docker-compose.yml   # local Postgres + minio (S3-compatible) + mailpit
├── .env.example  .eslintrc.cjs  .prettierrc  vitest.config.ts  playwright.config.ts
└── README.md  package.json  tsconfig.json  next.config.mjs
```

**Key discipline rules, enforced by lint/CI:**
- `src/lib/**` must not import `src/modules/**` or `src/app/**`.
- A module must not import another module's `server/` directory. Cross-module calls go through `lib/`.
- Every `modules/*/server/*.ts` business function must call `authorize()` and write an audit entry. A lint rule rejects service functions that import Prisma directly without going through `lib/db`.
- No Tanzanian tax or bank-format constants in code — only in `prisma/seed.ts` (accounts, reason codes) and in runtime configuration tables.

---

## 5. RBAC Design

### 5.1 Permission model (PDF §5)

Permissions are the Cartesian product of **Module × Action**, plus optional **resource** narrowing:

`Permission { module, action, resource? }` — e.g. `(SUPPLIERS, EDIT, "supplier.bank_details")` with `requiresStepUpAuth = true`.

**Actions (PDF §5, exactly these 11):** `VIEW, CREATE, EDIT, SUBMIT, APPROVE, REJECT, POST, REVERSE, EXPORT, CONFIGURE, ADMINISTER`.

`ModuleKey` includes reserved Phase 2+ entries so grants can be defined ahead of the module existing, and the UI renders "module not available in Phase 1" rather than a broken link.

### 5.2 Roles (Phase 1)

| Role | Code | Notes |
|---|---|---|
| CEO | `CEO` | `isSystem`, `isFinalApprover = true`. Executive dashboard, all approvals, period reopen sign-off, final close sign-off, user/permission oversight, audit visibility, **cannot post** unless separately granted (separation of duties — see Q6). |
| Finance Officer | `FINANCE_OFFICER` | Records, reconciles, prepares budgets/invoices/payments/receipts/documents, prepares close, submits for approval, **cannot approve own submissions** (PDF §3.2). |
| Auditor (read-only) | `AUDITOR` | Seeded, unassigned in Phase 1. `VIEW` on ledger/reports/audit; no `EDIT`/`POST`. Architected now (PDF §3.3) so access reviews work from day one. |

Phase 2+ roles (Accountant, Project Manager, Procurement Officer, Inventory Officer, Asset Manager, HR/Payroll, Department Manager, Team Member, External Accountant, External Auditor, Consultant, System Administrator) are **data rows created in a later milestone**, not code. `RoleType.STANDARD` plus `rolePermissions` means adding a role is a data insert, not a deploy.

### 5.3 Dimension scoping (PDF §5: project, department, location, funding source, financial account)

`RoleScopeGrant { roleId, permissionId?, dimension, dimensionValueId?, includeChildren, effect }`

Resolution algorithm in `lib/rbac/scope.ts`:

1. Collect all grants for the actor's active roles (non-revoked, non-expired `UserRole`, including roles reached through an unexpired `Delegation`).
2. For each `dimension`, gather `ALLOW` ids and `DENY` ids.
3. **DENY always wins.**
4. A row is readable/editable only if it has **no** applicable dimension, or its dimension value is in `ALLOW`.
5. `includeChildren = true` expands the hierarchical `Location` / `Department` trees.
6. A grant with no `permissionId` applies to **all** actions in that module for that dimension.

Dimension values are extracted from the entity via `lib/dimensions/extract.ts`, which returns a uniform `{ projectId, departmentId, costCentreId, locationId, fundingSourceId, accountId }` for any business record — so the filter is uniform across transactions, invoices, budgets and journal lines.

### 5.4 Server-side enforcement layer (not UI-only)

**The rule: the UI may hide or disable a control for usability, but it is never the enforcement point. Every check happens in a service function.**

```
UI button visibility  →  cosmetic only, derived from the same authorize() result
Server Action / API   →  authorize() BEFORE any mutation or read  ← ENFORCED HERE
Kernel service fn     →  re-checks SOD, period state, budget, and writes audit
Database              →  RLS-style triggers + tenant extension as final backstop
```

Concretely:

```ts
// lib/kernel/authorize.ts — the single entry point every service uses
async function authorize(ctx: RequestContext, req: {
  module: ModuleKey
  action: PermissionAction
  entity?: { type: AuditEntityType, id?: string, dimensions?: Dimensions }
}): Promise<void>
```

- Called as the **first statement** of every service function.
- Throws `AuthorizationError` (never returns a boolean) so it cannot be accidentally ignored.
- Throws `StepUpAuthRequired` when `permission.requiresStepUpAuth` is set (supplier bank details, exports of high-value data, permission changes, period reopen).
- Scoped list queries go through `lib/rbac/scope.ts#applyScopeFilter()`, which injects Prisma `where` clauses. **There is no unfiltered `findMany` on a permissioned model in any module.**
- Route handlers add defence in depth: middleware session check + per-route `authorize()`; Server Actions are thin wrappers over the same service functions.
- **Export authorization** is separate from view authorization (PDF §49): `(REPORTS, VIEW)` does not imply `(EXPORTS, EXPORT)`.
- **Audit authorization** is separate again: audit visibility requires `AUDIT_TRAIL:VIEW`, and audit *content* is redacted for non-admins.
- **Permission changes require step-up auth** and are written to `AuditLog` with full before/after.
- Tests assert the negative path: a Finance Officer calling the posting endpoint directly with a crafted payload gets `403` **and** an `ACCESS_DENIED` audit entry.

### 5.5 Segregation of duties

- `ApprovalPolicy.forbidSelfApproval = true` — the preparer cannot approve their own submission, **even if they hold the `APPROVE` permission**.
- `ApprovalPolicy.forbidApproverAsPreparer = true` — no chain where the same person prepares and approves at any step.
- The posting layer independently re-checks `postedById !== submittedById`.
- `Payment` to a supplier whose bank details changed within the control window is **blocked at the service layer** (PDF §23), not merely flagged.
- Failed SOD attempts produce a `SecurityEventType.SOD_VIOLATION_ATTEMPT`.

### 5.6 Temporary access, delegation, auto-expiry (PDF §4)

- `UserRole.isTemporary` + `expiresAt`; `Delegation.expiresAt` is **mandatory**.
- A nightly job sets `revokedAt` on expired grants and revokes affected `Session` rows, writing `DELEGATION_REVOKED` / `ROLE_REMOVED` audit entries.
- Effective-permission resolution filters `expiresAt > now()` on every request, so an expired grant is inert even before the nightly job runs.
- `AccessReview` + `AccessReviewItem` drive periodic certification of who holds what.

---

## 6. Approval Workflow Engine Design

### 6.1 Design goals

Generic, reusable, and **configurable per transaction type** — `BUILD_PROMPT.md` §6. Adding a new approvable entity type must require **no engine change**, only a policy row.

### 6.2 Model

`ApprovalPolicy` (the definition, versioned) → `ApprovalPolicyStep[]` (ordered, conditional) → at runtime produces `ApprovalRequest` + `ApprovalStepInstance[]` + `ApprovalDecisionRecord[]`.

**Policy selection:** given `(entityType, amount, currency, context)`, the engine picks the highest-priority `isActive` policy whose `minAmount ≤ amount ≤ maxAmount`, currency matches (or is null), and whose `conditions` all evaluate true against the request context.

**Frozen snapshot:** on request creation, the entire policy is serialised into `ApprovalRequest.policySnapshot`. If someone edits the policy mid-flight, **in-flight requests are unaffected** — history is immutable by construction.

### 6.3 Step evaluation pipeline

```
requestApproval(entity)
  1. authorize(ctx, { module, action: SUBMIT })
  2. assertSeparationOfDuties(entity, ctx.actor)        // reject early
  3. selectPolicy(entityType, amount, currency, context)
  4. evaluateStepConditions(policy.steps, context)      // drop inapplicable steps
  5. resolveEligibleApprovers(step, actor, delegations) // apply delegations + expiry
  6. tx: create ApprovalRequest + StepInstances + snapshot
          + audit(APPROVAL request created) + notifications
  7. return requestId

decideApproval(requestId, stepOrder, decision, comments)
  1. load request FOR UPDATE
  2. assert actor ∈ eligibleUserIds           (401/403)
  3. assert actor ≠ preparer                   (SOD)
  4. assert step.status ∈ (PENDING, IN_PROGRESS)
  5. assert step-up auth if the step requires it
  6. tx:
       - insert ApprovalDecisionRecord (with delegation snapshot + SOD evidence)
       - update step counters
       - if step satisfied -> activate next step (or finish)
       - if rejected -> terminal REJECTED (or RETURNED_TO_PREVIOUS)
       - if final step approved and policy.requiresFinalApprover
             -> assign final approver (CEO role) for SIGN_OFF
       - update entity status (SUBMITTED -> APPROVED / REJECTED)
       - audit(APPROVAL / REJECTION) + notifications
  7. idempotency key required — a double-click cannot approve twice
```

### 6.4 Configurable per transaction type

Seed policies in Milestone 6 (amount thresholds to be confirmed — **Q2**):

| Entity | Steps |
|---|---|
| `TRANSACTION` | Finance review → **CEO approval** (all amounts in Phase 1; Finance Officer cannot self-approve) |
| `INVOICE` | Finance review → CEO approval above threshold |
| `PAYMENT` (outbound) | Budget guard → Finance review → **CEO approval** → posting |
| `QUOTATION` | Finance review → CEO approval above threshold |
| `BUDGET` / `BUDGET_REVISION` | Finance prepare → **CEO approval** |
| `BUDGET_TRANSFER` | Finance → CEO (locked funds require CEO regardless of amount) |
| `PERIOD_REOPEN` | **CEO approval only** (PDF §54 "period reopening" is an audited security event) |
| `FINANCIAL_CLOSE` | Finance checklist → **CEO final sign-off** (PDF §64) |
| `SUPPLIER_BANK_DETAIL_CHANGE` | Verification step → **maker-checker: a different person** must approve (PDF §23) |
| `MASTER_DATA_CHANGE` | Data steward → Finance/CEO per `entityType` |
| `IMPORT_BATCH` | Finance validation → approval before any row is committed (PDF §52) |
| `RECONCILIATION` | Finance prepare → CEO approval when difference ≠ 0 |
| `ADJUSTMENT` / `REVERSAL` | Finance → CEO (value of the correction; reversal of a CEO-approved item always routes to CEO) |

Conditions available per step: `AMOUNT_GREATER_THAN`, `AMOUNT_BETWEEN`, `OVER_BUDGET`, `FUNDING_RESTRICTED`, `NEW_COUNTERPARTY`, `SUPPLIER_BANK_DETAIL_CHANGED`, `CURRENCY_NOT_BASE`, `CROSS_PROJECT`, `MANUAL_FLAG`.

### 6.5 Non-negotiable engine rules

1. **The engine never approves.** It routes and records. A decision always requires a named human actor, and `ApprovalDecisionRecord` is the proof.
2. **The Finance Officer cannot bypass CEO approval.** There is no `canBypassApproval` path — the column exists at `false` and a test asserts no code path can set it true.
3. **The engine does not touch money.** It flips document states; the posting layer independently re-verifies every invariant and requires `outcome = APPROVED`.
4. **Delegation is resolved at step activation**, and the decision record snapshots *which* delegation was used — so a revoked delegation still explains a historic approval.
5. **Rejection is terminal by default** (`onReject = TERMINATE`); returning to a previous step is configurable but audited.
6. **Every state change is audit-logged** and notification-dispatched in the same transaction.

---

## 7. Audit Trail Design

### 7.1 Guarantees (PDF §54)

Append-only · tamper-evident · tamper-**resistant** (DB privileges) · permission-restricted · queryable · permanently linkable to every financial action.

### 7.2 Exact fields recorded on `AuditLog`

| Field | Purpose |
|---|---|
| `id` | Primary key |
| `sequence` | Auto-increment, **unique** — total ordering across the chain |
| `previousHash` | Hash of the prior entry; `null` only for the genesis entry |
| `entryHash` | `sha256(previousHash ‖ sequence ‖ actorId ‖ action ‖ entityType ‖ entityId ‖ changes ‖ occurredAt)` — **unique** |
| `signature` | HMAC-SHA256 over `entryHash` using a key rotated per accounting period (stored in the secret store) |
| `organizationId` | Tenant |
| `actorId` | Who acted (`null` for system jobs) |
| `actorName` | Denormalised — survives user deletion |
| `actorRoleCodes` | Roles active at action time — survives later role changes |
| `action` | `AuditAction` enum (covers all 14 categories PDF §54 enumerates) |
| `entityType` / `entityId` / `entityLabel` | What was affected |
| `description` | Human-readable summary |
| `changes` | `{ field: { from, to } }` for every mutated field |
| `metadata` | Context (period id, policy id, request id, reason code, offline sync key) |
| `ipAddress` | Network origin |
| `userAgent` | Client fingerprint |
| `requestId` | Correlates all log lines for one request |
| `sessionId` | Which session acted |
| `channel` | `WEB / API / CLI / SYSTEM / SYNC` — distinguishes offline replay from live entry |
| `result` | `SUCCESS / FAILURE / DENIED / PARTIAL` — **denials are logged too** |
| `errorMessage` | Failure detail |
| `occurredAt` | Event time (client-supplied for offline sync) |
| `recordedAt` | Server write time — divergence between the two is itself a signal |

**Coverage against PDF §54's list:** login ✓, logout ✓, transaction creation ✓, transaction modification ✓, approval ✓, rejection ✓, reversal ✓, document upload ✓, document download ✓, user changes ✓, permission changes ✓, export ✓, configuration changes ✓, period reopening ✓, integration activity ✓, security events ✓.

### 7.3 Append-only enforcement

1. Application: `lib/audit` exposes **only** `write()` and `read()`. No `update`/`delete` API exists.
2. Database: `BEFORE UPDATE OR DELETE` trigger raises unconditionally on `audit_logs`.
3. Privilege: `REVOKE UPDATE, DELETE ON audit_logs FROM app_user` — the app's own DB role cannot modify them even with a SQL injection.
4. Tamper-evidence: the hash chain; `AuditChainCheckpoint` seals each day; a scheduled job verifies and flips checkpoints to `VERIFIED` or `BROKEN`. A `BROKEN` checkpoint raises a `CRITICAL` `SecurityEvent` and notifies the CEO.

### 7.4 Same-transaction guarantee

Audit writes use the **same Prisma transaction** as the business mutation. `lib/db/withAudit()` wraps every service mutation:

```ts
await withAudit(ctx, async (tx) => {
  const row = await tx.transaction.create({ ... })
  await tx.auditLog.create({ data: auditEntry({ action, entityType, entityId, changes }) })
  return row
})
```

If the audit insert fails, the whole transaction rolls back — an unaudited mutation is impossible.

### 7.5 Queryability and access control

- The audit UI (`/admin/audit-trail`) filters by actor, action, entity type/id, date range, result, channel, IP — powered by TanStack Table.
- Access requires `(AUDIT_TRAIL, VIEW)`, enforced in `lib/rbac`. Audit rows for security-sensitive fields (failed password attempts, MFA state) are further restricted to `ADMINISTER` on `USERS_ROLES`.
- **Audit itself is audited**: viewing, filtering and exporting audit data writes a new audit entry (PDF §49 export logging applies to the audit log too).

### 7.6 Retention

Per PDF §56, audit retention is **indefinite for financial actions** — the `RetentionPolicy` for `AuditLog` is `RETAIN_FOREVER`. Only session/login telemetry older than the configured window may be pruned, and pruning is itself an audited `RETENTION_APPLIED` event.

---

## 8. Phase 1 Milestone Breakdown

17 milestones. Each is **independently testable** and ships with code, migrations, tests and a short "how to run / how to verify" note. Per `BUILD_PROMPT.md` §13, I will build **Milestone 1 only**, then STOP for your testing.

---

### M1 — Foundation, Authentication, Base RBAC, Audit Foundation

**Goal:** A running Next.js app with secure authentication, server-side RBAC, and a working tamper-evident audit log — the bedrock every later milestone depends on.

**Deliverables**
- Repo scaffold: Next.js App Router + TS, Tailwind, shadcn/ui, Prettier, ESLint (with the kernel import-graph zones), Vitest, Playwright.
- CI pipeline: `lint → typecheck → test → build`.
- `docker-compose.yml` (Postgres + minio S3-compatible + mailpit).
- Auth.js v5 self-hosted, credentials provider, argon2id hashing.
- MFA (TOTP) enrolment + challenge, enforced for CEO and Finance Officer.
- Password reset by email, password-change with history invalidation.
- Sessions: idle + absolute timeouts, rotation, device tracking, secure cookies, revoke-all.
- Login history, lockout, rate limiting — all thresholds from `AuthPolicy` (config, not code).
- Base RBAC: `Role`, `Permission`, `RolePermission`, `UserRole`, `RoleScopeGrant`; seeded `CEO`, `FINANCE_OFFICER`, `AUDITOR`.
- `lib/rbac/authorize()` + `applyScopeFilter()` + route middleware.
- `lib/audit` writer with hash chain, `withAudit()` tx wrapper, chain verifier, `/admin/audit-trail` query UI.
- App shell: navy/slate theme, sidebar, top bar, notification bell placeholder, i18n scaffold (English).
- Module registry skeleton proving kernel/module separation.

**DB changes:** `users`, `mfa_devices`, `sessions`, `login_history`, `auth_policies`, `roles`, `permissions`, `role_permissions`, `user_roles`, `role_scope_grants`, `delegations`, `access_reviews`, `access_review_items`, `organizations`, `audit_logs`, `audit_chain_checkpoints`, `security_events`, `idempotency_keys`, `notifications`, `notification_preferences`. Raw SQL: audit append-only trigger + hash chain function.

**API routes:** `POST /api/v1/auth/login`, `/mfa/verify`, `/logout`, `/refresh`, `/password/forgot`, `/password/reset`, `/password/change`; `GET/POST /api/v1/users`; `GET/POST /api/v1/roles`; `GET /api/v1/audit`.

**UI screens:** `/login`, `/mfa-verify`, `/forgot-password`, `/reset-password`, `/dashboard` (placeholder), `/admin/users`, `/admin/roles`, `/admin/delegations`, `/admin/access-reviews`, `/admin/audit-trail`, `/settings/security`.

**Tests:** argon2 hashing round-trip; login success/failure/lockout/rate-limit; MFA enrol + verify + wrong-code + replay rejection; session idle/absolute expiry and rotation; password reset token expiry/single-use; permission matrix (unit + integration); **negative-path test: direct call to a protected endpoint without permission → 403 + `ACCESS_DENIED` audit entry**; audit chain hash continuity; audit append-only trigger rejects `UPDATE`/`DELETE`; delegation expiry renders permissions inert; kernel import-graph test (no upward edges).

**Definition of done:** CEO and Finance Officer can log in with MFA, an unauthorised direct API call returns 403 and is audited, the audit chain verifies clean, `npm run lint && npm run typecheck && npm test && npm run build` all pass, CI green, "how to verify" note written.

---

### M2 — Organisation Structure, Dimensions, Master Data, Currency & FX

**Goal:** The shared organisational substrate (PDF §74) and the dimension model every financial record carries.

**Deliverables**
- Organisation setup screen incl. `registrationStatus = NOT_REGISTERED` and nullable TIN (PDF §2).
- Locations (incl. `UNIVERSITY_FACILITY` / `PERMITTED_USE` for Mbeya), Departments, Cost Centres, Projects (incl. Iventika, Uzanite), Funding Sources (incl. restricted grants).
- Currencies: TZS base + USD/EUR/GBP; exchange-rate entry and import; transaction-date rate lookup (PDF §50).
- `lib/fx` conversion with configurable rounding and FX-difference treatment (expense / income / suspense).
- Master data change requests: approval, version history, effective date, old/new value, reason, audit (PDF §62).
- Reason codes catalogue.
- Lightweight `ProductService` catalogue for revenue linkage (PDF §14/§18).

**DB changes:** `locations`, `departments`, `cost_centres`, `projects`, `funding_sources`, `currencies`, `exchange_rates`, `master_data_change_requests`, `master_data_versions`, `reason_codes`, `products_services`, `parties`, `party_addresses`, `contacts`, `communication_logs`.

**API routes:** CRUD `/api/v1/locations`, `/departments`, `/cost-centres`, `/projects`, `/funding-sources`, `/currencies`, `/exchange-rates`, `/reason-codes`, `/products-services`; `POST /api/v1/master-data/changes`, `/changes/:id/approve`.

**UI screens:** `/master-data` (locations, departments, cost centres, projects, funding sources, currencies, rates, reason codes), `/master-data/history`, `/settings/organization`.

**Tests:** master-data change requires approval and writes old/new; version history snapshots; effective dating; dimension extraction helper returns correct dimensions for each entity type; FX conversion at a historical date returns the transaction-date rate; missing rate → explicit error, never a silent fallback; restricted funding source cannot be used outside its scope; import of exchange rates is idempotent.

**Definition of done:** Iventika and Uzanite exist as usable project dimensions; TZS/USD/EUR/GBP configured with TZS base; an FX conversion is reproducible from a given date; a master-data edit without approval is rejected and audited; "how to verify" note written.

---

### M3 — Chart of Accounts, Financial Periods, Opening Balances

**Goal:** A configurable CoA seeded exactly per PDF §7 (including dormant Phase 2 accounts), plus period control and honest opening balances.

**Deliverables**
- CoA CRUD with hierarchical accounts, types, normal balances, postable/lockable, reconcilable, document-required flags.
- **Seed per PDF §7**, including `INVENTORY`, `EQUIPMENT`, `FUTURE_INVESTMENT`, SaaS / token-packages / component-sales revenue, salaries, hardware/prototyping — active but dormant.
- `validatedByQualifiedAccountant` flag + validator notes (PDF §7 requirement recorded, not assumed).
- Period management: monthly / quarterly / annual, auto-generation, adjustment periods, backdating flag.
- Open → Closing → Closed → Locked lifecycle, plus `REOPEN_PENDING` / `REOPENED` with `reopenCount`.
- Opening balances with **`isUnverified` defaulting to `true`** and `verificationStatus = UNVERIFIED` (PDF §2) — supports one-sided/partial historical entry.
- Period-lock DB triggers.

**DB changes:** `accounts`, `financial_periods`, `opening_balances`, `account_balance_snapshots`; raw SQL: period-lock trigger; seed data.

**API routes:** CRUD `/api/v1/accounts`, `/api/v1/periods`; `POST /periods/:id/open|close|lock`, `POST /periods/:id/reopen-request`, `POST /periods/:id/reopen-approve`; `GET/POST /api/v1/opening-balances`; `POST /opening-balances/:id/verify`.

**UI screens:** `/accounting/chart-of-accounts` (tree + detail), `/accounting/opening-balances`, `/periods`, `/periods/[id]`.

**Tests:** account code uniqueness; cannot post to a non-postable account; period auto-generation covers the year without overlap; posting into a LOCKED period is rejected by the **trigger** (not just the service); reopen requires an approved request and increments `reopenCount`; opening balances default to unverified; verifying requires a note; a historical opening balance **cannot** be created without `source`.

**Definition of done:** full PDF §7 CoA present with dormant Phase 2 accounts; FY periods generated; the TZS 3,900,000 bootcamp-style partial historical position can be entered and is visibly flagged unverified; locked-period posting fails at the database; "how to verify" note written.

---

### M4 — Double-Entry Core, General Ledger, Trial Balance, Financial Statements

**Goal:** The accounting heart — balanced journals, posting, GL, trial balance, and the core statements.

**Deliverables**
- Manual journal entry with lines, dimensions, validation and a live balance indicator.
- `lib/accounting/posting.ts`: balance check, period check, SOD check, approval check, account-lock check, number allocation, base-currency computation.
- GL by account / period / dimensions; account statement; running balance.
- Trial balance (as-at date, multi-currency and base).
- Income statement, balance sheet, cash flow (PDF §47).
- Adjustments, reversals (full/partial) and correcting entries with reason codes, evidence and links to the original; **the original entry remains visible** (PDF §9).
- Immutability trigger on posted entries.
- `AccountBalanceSnapshot` rebuild job (non-authoritative cache).

**DB changes:** `journal_entries`, `journal_lines`, `account_balance_snapshots`; raw SQL: balance + immutability triggers.

**API routes:** CRUD `/api/v1/journal-entries`; `POST /journal-entries/:id/submit|approve|post|reverse|void`, `POST /journal-entries/:id/adjust`; `GET /api/v1/general-ledger`, `/trial-balance`, `/reports/income-statement`, `/balance-sheet`, `/cash-flow`.

**UI screens:** `/accounting/journal-entries` (list, `[id]`, `new`, `[id]/reverse`), `/accounting/general-ledger`, `/accounting/trial-balance`, `/reports/financial/*`.

**Tests:** unbalanced entry cannot be posted; entry into a locked period rejected; poster ≠ submitter rejected; posting without approval rejected (except policies that do not require it); posted entry `UPDATE`/`DELETE` rejected by trigger; **reversal produces a linked, opposite entry and the original stays visible**; partial reversal leaves the correct residual balance; trial balance debits equal credits; balance sheet balances; income statement ties to the GL; `JournalLine` is the sole source of balances (snapshot truncation + rebuild reproduces identical figures).

**Definition of done:** a balanced journal posts; a locked-period post fails at the database layer; a posted journal cannot be edited or deleted; a reversal is traceable to its original; trial balance balances; statements tie to the GL; "how to verify" note written.

---

### M5 — Transaction Lifecycle & Workflow State Machine

**Goal:** The PDF §8 business workflow over the accounting core, with full metadata and immutable approved records.

**Deliverables**
- `lib/workflow` state machine: `DRAFT → SUBMITTED → APPROVED/REJECTED → POSTED/LOCKED → ADJUSTED/REVERSED`, with **only legal transitions permitted**; every attempt (including illegal ones) is audited.
- Transaction form carrying every PDF §8 field: id, date, description, account, amount, currency, project, department, cost centre, funding source, payment method, supporting document, creator, approval status, approval history.
- Submission generates a journal entry on posting; posting updates budget actuals and account balances in one transaction.
- Adjust / reverse screens requiring reason code + evidence + link to the original.
- Cancel/delete permitted **only** while DRAFT.
- List with filter, sort, search, export.

**DB changes:** `transactions`; workflow-state transition log table (audit covers it).

**API routes:** CRUD `/api/v1/transactions`; `POST /transactions/:id/submit|approve|reject|post|adjust|reverse|cancel`.

**UI screens:** `/transactions` (list), `/transactions/[id]` (timeline + audit + documents), `/transactions/new`, `/transactions/[id]/adjust`, `/transactions/[id]/reverse`.

**Tests:** every legal transition succeeds; every illegal transition is rejected and audited; `APPROVED`/`POSTED` cannot be edited or deleted (service **and** trigger); posting creates exactly one journal entry and is idempotent under a repeated request (idempotency key); reversal links to the original and preserves visibility; transaction without required evidence on a document-required account is rejected; dimension values are persisted on both the transaction and the generated journal lines.

**Definition of done:** the full lifecycle runs end to end; an approved transaction cannot be silently changed; a reversal leaves a complete, linked trail; illegal transitions are rejected and visible in the audit trail; "how to verify" note written.

---

### M6 — Approval Workflow Engine, Policies, Delegations, Access Reviews

**Goal:** The generic, configurable approval engine with CEO final authority and enforced separation of duties.

**Deliverables**
- `ApprovalPolicy` / `ApprovalPolicyStep` configuration UI (ordered, conditional steps).
- `lib/approvals` engine per §6.3 (select policy → evaluate conditions → resolve approvers incl. delegations → record decisions → advance).
- Frozen `policySnapshot` on every request.
- Conditions: amount thresholds, over-budget, restricted funding, new counterparty, changed supplier bank details, non-base currency, cross-project, manual flag.
- Segregation of duties: no self-approval, no preparer-as-approver (enforced in engine **and** re-checked at posting).
- Delegated authority with mandatory expiry; auto-expiry job; delegation-aware decision records.
- Approval inbox, request detail with timeline, policy history.
- Access reviews (certify/revoke).

**DB changes:** `approval_policies`, `approval_policy_steps`, `approval_requests`, `approval_step_instances`, `approval_decision_records`; seed policies.

**API routes:** CRUD `/api/v1/approval-policies`; `POST /api/v1/approvals`, `POST /approvals/:id/decide`, `POST /approvals/:id/cancel`; CRUD `/api/v1/delegations`; `/api/v1/access-reviews`.

**UI screens:** `/approvals` (inbox, filters, SLA), `/approvals/[id]`, `/approvals/policies`, `/admin/delegations`, `/admin/access-reviews`.

**Tests:** policy selected correctly by amount band; inapplicable steps dropped; condition evaluation table-driven; **Finance Officer cannot approve their own submission even with the `APPROVE` permission**; preparer cannot approve at any step; CEO is final approver where configured; delegation routes the step and is snapshotted on the decision; expired delegation is inert; edited policy does not affect in-flight requests; double-decision rejected by idempotency; every decision writes an `ApprovalDecisionRecord` with SOD evidence.

**Definition of done:** a transaction submitted by the Finance Officer routes to the CEO and cannot be self-approved; a delegation works and expires; editing a policy leaves in-flight requests unchanged; every decision is individually auditable; "how to verify" note written.

---

### M7 — Treasury: Cash, Bank, Mobile Money, Gateways, Transfers, Cash Position

**Goal:** Full cash and bank management per PDF §10, with transfers that never distort the P&L.

**Deliverables**
- Treasury accounts across all `TreasuryAccountKind` values (cash, bank, mobile money, payment gateway, project fund, grant fund, other), each linked to a ledger account; encrypted sensitive fields.
- Bank account management with statement-format metadata for import.
- Deposits, withdrawals, payments, receipts generated from ledger-backed documents.
- **Transfers** implemented as paired journal entries — structurally incapable of appearing as revenue or expense.
- Account balances, cash position, liquidity view.
- Payment schedules with due/overdue status.
- Mobile-money accounts with provider recorded as configuration (no hardcoded provider logic).

**DB changes:** `treasury_accounts`, `transfers`, `payment_schedules`.

**API routes:** CRUD `/api/v1/treasury-accounts`; `POST /treasury-accounts/:id/deposit|withdrawal`; CRUD `/api/v1/transfers`, `POST /transfers/:id/submit|approve|process|reverse`; `GET /api/v1/cash-position`, `/api/v1/payment-schedules`.

**UI screens:** `/treasury/cash`, `/treasury/bank`, `/treasury/mobile-money`, `/treasury/gateways`, `/treasury/accounts`, `/treasury/accounts/[id]`, `/treasury/transfers`, `/treasury/cash-position`.

**Tests:** **a bank→mobile-money transfer leaves revenue and expense totals unchanged** (explicit regression test for PDF §10); transfer is exactly one balanced entry with a credit to source and a debit to destination; cross-currency transfer produces an FX difference entry; transfer into a locked period is rejected; reversal of a transfer returns funds and links correctly; account balances equal the sum of their journal lines; restricted grant accounts reject non-eligible transactions.

**Definition of done:** a transfer moves money between two accounts without touching revenue or expenses (proven by test); cash position matches the ledger; bank and mobile money balances reconcile to their accounts; "how to verify" note written.

---

### M8 — Bank Statement Import & Reconciliation

**Goal:** The PDF §11 import pipeline and the PDF §12 reconciliation engine, with matching, exceptions and approval.

**Deliverables**
- Upload Excel/CSV → store → hash (duplicate-upload block).
- **Seven-stage gated pipeline:** Upload → Map Fields → Validate → Preview → Detect Duplicates → Approve → Import (PDF §52). Each stage blocks the next until complete.
- Field mapping persistence per bank/source; date formats and amount conventions (single column / separate debit-credit / signed).
- Validation with row-level errors; **error queue** (`ImportError`) with resolution workflow.
- Duplicate detection by normalised fingerprint, within-file and against prior imports and existing transactions.
- `rawData` preserved verbatim; `source`, `importDate`, `verificationStatus` recorded per row (PDF §52).
- Reconciliation sessions per treasury account and period, across all `ReconciliationTarget` values.
- Matching engine: exact, date-window, amount-tolerance, reference-similarity, partial, one-to-many, many-to-one; configurable `MatchingRule` ordering and confidence threshold.
- Auto-match proposals requiring **human confirmation**; exception queue; adjustments requiring approval before posting.
- Reconciliation approval, lock, reopen, and reconciliation reports.

**DB changes:** `bank_statement_imports`, `import_field_mappings`, `bank_statement_lines`, `matching_rules`, `reconciliation_sessions`, `reconciliation_matches`, `reconciliation_exceptions`, `reconciliation_adjustments`, `import_batches`, `import_rows`, `import_mappings`, `import_errors`.

**API routes:** `POST /api/v1/imports/statement/upload`; `GET|POST /imports/:id/mapping`; `POST /imports/:id/validate`; `GET /imports/:id/preview`; `POST /imports/:id/detect-duplicates`; `POST /imports/:id/approve`; `POST /imports/:id/commit`; `POST /imports/:id/rollback`; `GET|POST /imports/:id/errors`, `/errors/:id/resolve`; CRUD `/api/v1/reconciliations`; `POST /reconciliations/:id/auto-match`, `/matches/:id/confirm`, `/adjustments`, `/approve`.

**UI screens:** `/treasury/statement-import` (upload → mapping → validation → preview → duplicates → approve), `/treasury/statement-import/[id]/errors`, `/treasury/reconciliation` (list), `/treasury/reconciliation/[id]` (workbench with matching), `/treasury/reconciliation/[id]/exceptions`, `/treasury/reconciliation/[id]/reports`.

**Tests:** import blocked until the preceding stage completes; duplicate file hash rejected; malformed dates/amounts quarantined to the error queue with the original value retained; duplicates detected within file and across imports; preview matches the committed result exactly; **rollback restores pre-import state and is audited**; one-to-many and partial matching produce correct amounts; an auto-match cannot be committed without confirmation; reconciliation difference of zero required before approval; adjustment without a reason code is rejected; posted adjustment is balanced and linked.

**Definition of done:** a real statement file imports through all seven gates with the error queue populated and duplicates flagged; a reconciliation session balances to zero difference and requires approval before locking; rollback works; "how to verify" note written.

---

### M9 — Budgets & Commitments

**Goal:** PDF §13 budgeting with the mandated formula `Approved − Commitments − Actual = Available`, warnings and controlled over-budget approval.

**Deliverables**
- Budgets at company, department, project, funding-restricted and activity levels.
- Budget lines by account with optional monthly phasing.
- Commitments (from invoices, payment schedules, manual) — PDF §67.
- **Live availability calculation**, recomputed on every posting and commitment change.
- Budget-vs-actual views; forecast of spending; warnings; over-budget alerts.
- **Budget guard at posting**: over-budget transactions require additional approval (`OVER_BUDGET` condition routes to the CEO).
- Budget revisions (with line-level before/after), budget transfers between accounts, lightweight scenario planning (best / expected / worst case).
- Full budget history.

**DB changes:** `budgets`, `budget_lines`, `budget_revisions`, `budget_revision_lines`, `budget_transfers`, `commitments`, `budget_scenarios`.

**API routes:** CRUD `/api/v1/budgets`, `/budgets/:id/lines`, `/budgets/:id/submit|approve|activate`; `POST /budgets/:id/revisions`, `/revisions/:id/approve`; `POST /budgets/:id/transfers`; CRUD `/api/v1/commitments`; `GET /budgets/:id/vs-actual`.

**UI screens:** `/budgets` (list + filters), `/budgets/[id]` (lines, actuals, available, warnings), `/budgets/[id]/revisions`, `/budgets/[id]/transfers`, `/budgets/[id]/scenarios`, `/budgets/[id]/history`.

**Tests:** `available = approved − commitments − actual` exactly, at every level; posting an expense reduces available by the correct amount; commitment creation reserves budget; settlement releases it; over-budget posting is **blocked without additional approval** and permitted once approved; restricted funding budget rejects ineligible expenses; revision requires approval and preserves before/after; transfer between lines updates both and is audited; scenario projections are non-destructive.

**Definition of done:** the availability formula holds to the shilling across all budget levels; an over-budget transaction cannot post without CEO approval; revisions and transfers are approval-gated and audited; "how to verify" note written.

---

### M10 — Customers, Suppliers, Credit & Supplier Payment Security

**Goal:** Master records with credit management (PDF §17) and the PDF §23 supplier payment-detail controls.

**Deliverables**
- Customers: profile, contacts, addresses, tax info, payment terms, credit limit, status, relationship owner, communication history, outstanding balance, aging, risk level, credit hold.
- Suppliers: profile, business and tax details, payment information, products/services supplied, pricing (basic), performance/quality/delivery ratings, risk level.
- Contacts and `CommunicationLog` shared across both.
- **Credit limit enforcement** — invoicing beyond the limit triggers a credit hold, and a held customer cannot be invoiced until released.
- Aging, overdue invoices, payment reminders, collection tasks, risk alerts.
- **Supplier bank detail change control (PDF §23):** change request → verification → maker-checker approval (requester can never approve) → previous value preserved → evidence required → notification → audit → payments to that supplier blocked during the control window.
- Master data approval and version history applied to both (PDF §62).

**DB changes:** `customers`, `suppliers`, `contacts`, `communication_logs`, `party_addresses`, `supplier_bank_details`, `supplier_bank_detail_change_requests`.

**API routes:** CRUD `/api/v1/customers`, `/api/v1/suppliers`; `POST /customers/:id/credit-hold|release`; `GET /customers/:id/aging`, `/customers/:id/outstanding`; `POST /suppliers/:id/bank-detail-changes`, `/bank-detail-changes/:id/verify|approve|reject`; `GET /suppliers/:id/risk`.

**UI screens:** `/customers` (list), `/customers/[id]` (profile, invoices, payments, aging, communications, documents), `/suppliers` (list), `/suppliers/[id]`, `/suppliers/[id]/bank-details` (change request + approval + full previous-value history).

**Tests:** credit limit blocks invoicing beyond the limit; credit hold blocks invoicing until released; supplier bank detail change creates a request with the previous value preserved; **the requester cannot approve their own change**; payments to that supplier are blocked while the change is pending; evidence is mandatory; notifications fire; audit records every stage; expired/changed accounts are never hard-deleted.

**Definition of done:** a customer's credit limit is enforced; a supplier bank-detail change cannot be self-approved and blocks payment to the new destination until fully approved and verified; previous values remain visible; "how to verify" note written.

---

### M11 — Quotations, Invoices, Payments, Receipts, Credit & Debit Notes

**Goal:** The complete AR/AP and revenue-recognition document chain per PDF §14/§16, wired to the ledger.

**Deliverables**
- Quotations: numbering, approval, send, accept, expiry, **conversion to invoice** (one or several invoices).
- Invoices: numbering, approval, send, tax-invoice support, partial invoices, recurring invoices, partial payments, outstanding balance, cancellation with reason.
- Payments: inbound/outbound, multi-method, partial, **allocation** (FIFO / automatic / manual), unapplied on-account credit, approval-gated, generates ledger entries.
- Receipts: issue, print, void with reason, linked to invoice/payment, supporting document, offline capture support (fields land in M17).
- Credit notes and debit notes with reasons, application to invoices, and ledger effect.
- AR/AP and aging reports; due dates and overdue tracking; payment reminders.
- Every document generates correct balanced journal entries; revenue is **not** recognised on a quotation.

**DB changes:** `quotations`, `quotation_lines`, `invoices`, `invoice_lines`, `payments`, `payment_allocations`, `receipts`, `receipt_lines`, `credit_notes`, `debit_notes`.

**API routes:** CRUD `/api/v1/quotations`, `/quotations/:id/submit|approve|send|accept|convert`; CRUD `/api/v1/invoices`, `/invoices/:id/submit|approve|send|cancel`; CRUD `/api/v1/payments`, `/payments/:id/submit|approve|complete|reverse`; `POST /payments/:id/allocations`; CRUD `/api/v1/receipts`; CRUD `/api/v1/credit-notes`, `/debit-notes`; `GET /api/v1/receivables/aging`, `/payables/aging`.

**UI screens:** `/sales/quotations` (list, `[id]`, `new`), `/sales/invoices` (list, `[id]`, `new`), `/sales/payments` (list, `[id]`, `new`), `/sales/receipts` (list, `[id]` printable), `/sales/credit-notes`, `/debit-notes`, `/reports/receivables-aging`, `/reports/payables-aging`.

**Tests:** quotation→invoice conversion carries lines and amounts; invoice creates a balanced AR/revenue/Tax entry; payment creates a balanced bank/AR entry; partial payment leaves the correct outstanding; one payment allocating to many invoices is correct and balanced; over-allocation rejected; FIFO allocation ordering correct; unapplied credit lands on the correct control account; credit note reverses revenue and reduces the invoice balance; cancelled invoice cannot be paid; **no revenue is recognised at quotation stage**; payment reversal restores balances and links to the original; numbering is sequential and gap-detected.

**Definition of done:** quote → invoice → payment → receipt works end to end with correct ledger effect at each step; partial and multi-allocation payments are exact; aging agrees with the ledger; credit notes reverse correctly; "how to verify" note written.

---

### M12 — Document Management (full)

**Goal:** Complete evidence handling per PDF §28 — the "supporting evidence" half of the core principle.

**Deliverables**
- PDF/photo upload with type/size validation, checksum, virus-scan hook, private storage, short-lived signed URLs.
- Pluggable storage provider (local in dev, S3-compatible in prod) behind one interface.
- Classification, tags, metadata, permission-aware search.
- **OCR-ready fields** (`ocrStatus`, `ocrText`, `ocrConfidence`) with a pluggable OCR adapter interface stubbed for Phase 3.
- Transaction matching — link documents to transactions, invoices, payments, receipts, parties, projects.
- Version history with reasons.
- Document approval flow.
- Expiry reminders and renewal tracking.
- Retention policies and **legal holds** (blocks deletion, audit).
- Secure download — every download logged (PDF §54).

**DB changes:** `documents`, `document_versions`, `tags`, `document_tags`, `document_links`, `retention_policies`, `legal_holds`.

**API routes:** CRUD `/api/v1/documents`; `POST /documents/upload`, `/documents/:id/versions`, `/documents/:id/links`, `/documents/:id/tags`; `POST /documents/:id/approve`; `POST /documents/:id/legal-hold|release-hold`; `GET /documents/:id/download-url`; `GET /api/v1/documents/search`.

**UI screens:** `/documents` (library, filters, tag/search), `/documents/[id]` (preview, versions, links, metadata, retention), `/documents/upload`, `/documents/expiring`.

**Tests:** oversize/incorrect-type upload rejected; checksum dedupe; signed URL expires; **download without permission is refused and the refusal is audited**; every successful download is audited; version history immutable; legal hold blocks deletion; retention job skips held documents; document required by an account blocks transaction posting without it; expired-document reminder generated.

**Definition of done:** evidence uploads, versions, links and expires correctly; legal hold genuinely prevents deletion; every access is permission-checked server-side and audited; "how to verify" note written.

---

### M13 — Tax & Compliance (configurable engine — no hardcoded values)

**Goal:** PDF §32/§42 implemented as **configuration**, with zero Tanzanian tax values in code.

**Deliverables**
- Tax rule CRUD: type, jurisdiction, rate, inclusive/exclusive, applicability conditions, effective dates, GL mapping, rounding, thresholds.
- **`appliesWhenOrganizationRegistered`** so pre-registration (PDF §2) correctly yields `NOT_APPLICABLE`.
- Tax calculation engine driven entirely by `TaxRule` rows; effective-date selection.
- Tax invoices with configurable numbering and validity; tax invoice numbers unique per organisation.
- Tax obligations and payments, filing deadlines, compliance documents.
- Licences / permits / certifications / registrations / memberships / domains / insurance as `Credential` records with expiry reminders and `NOT_APPLICABLE` for pre-registration items.
- Compliance dashboard and compliance reports.
- Verification tracking (`isVerified`, verified-by-professional fields) so accountant review is recorded.
- **A test that fails the build if any Tanzanian tax constant appears in application code.**

**DB changes:** `tax_rules`, `tax_obligations`, `tax_payments`, `credentials`, `compliance_documents`.

**API routes:** CRUD `/api/v1/tax-rules`, `/tax-obligations`, `/tax-payments`, `/credentials`; `POST /tax-obligations/:id/file`, `/tax-invoices/validate`; `GET /api/v1/compliance/status`, `/reports/compliance`.

**UI screens:** `/tax-compliance/rules`, `/tax-compliance/obligations`, `/tax-compliance/filings`, `/tax-compliance/credentials`, `/reports/tax`, `/reports/compliance`.

**Tests:** tax computed purely from configured rules; changing a rule changes future calculations without a deploy; effective-dated rules pick the correct version by document date; pre-registration yields `NOT_APPLICABLE` and no tax is charged; inclusive vs exclusive calculation correct; rounding mode honoured; unique tax invoice number enforced; **lint/unit test asserts no hardcoded tax rate literal in `src/`**; expired credential raises a reminder.

**Definition of done:** all tax behaviour is data-driven and demonstrably changes with configuration; nothing Tanzanian is hardcoded; pre-registration is handled correctly; compliance status is accurate; "how to verify" note written.

---

### M14 — Reporting & Exports

**Goal:** PDF §47 reports across financial, management, funding, compliance and executive categories, with permission-aware, logged exports.

**Deliverables**
- **Report registry** with declared availability — reports whose module is not built (e.g. asset register, Phase 2) are explicitly marked unavailable rather than broken.
- Financial: income statement, balance sheet, cash flow, general ledger, trial balance, AR, AP, bank reconciliation, (asset register — declared unavailable in Phase 1).
- Management: budget vs actual, project profitability, revenue analysis, expense analysis, cash position, burn rate, financial KPIs. (Runway and advanced forecasting are Phase 2 and are declared unavailable.)
- Funding: funding received, utilisation, restricted funds (from the funding-source dimension).
- Compliance: tax reports, compliance status, expiring documents.
- Executive: monthly CEO report, quarterly management report, annual report.
- Every report filterable by period, project, department, cost centre, funding source, location, currency.
- **Every report visibly marks unverified/historical figures** (PDF §2) — the CEO must not mistake a partial bootcamp figure for a closed one.
- Exports: PDF, Excel, CSV, print, structured JSON, accounting export, full backup export; all permission-aware and all logged (PDF §49).

**DB changes:** none required (queries over existing models); optional `AccountBalanceSnapshot` reuse.

**API routes:** `GET /api/v1/reports/{reportKey}` with filter params; `GET /api/v1/reports/{reportKey}/export?format=pdf|xlsx|csv|json`; `GET /api/v1/reports` (registry).

**UI screens:** `/reports` (registry with categories and availability), `/reports/[reportKey]` (filters + render + export buttons), `/reports/executive/monthly|quarterly|annual`.

**Tests:** each report's totals tie to the GL / trial balance; **unverified figures are flagged in output** (regression test on the unverified marker); budget vs actual equals the budget availability computation; restricted funding utilisation excludes ineligible spend; multi-currency reports present both original and base amounts with the rate and date used; an export without `(EXPORTS, EXPORT)` is refused **and audited**; every export writes an `EXPORT` audit entry with the format and filter set.

**Definition of done:** every Phase 1 report produces correct, GL-consistent figures; unverified data is visibly marked; exports respect permissions and are logged; unavailable reports are clearly declared; "how to verify" note written.

---

### M15 — Period Close, Financial Close & Year-End

**Goal:** PDF §63/§64 — period control, the closing checklist, adjustment periods, year-end and CEO sign-off.

**Deliverables**
- Period close wizard: run all automated checks, review, resolve or waive with reason, submit.
- Checklist items (PDF §64): bank reconciliation, cash reconciliation, receivables, payables, missing documents, unapproved transactions, budget variances, adjustments, financial statements, open-item disclosure, plus go-live cleanup.
- Automated checks compute real figures (e.g. unreconciled balance, invoices past due with no activity, transactions stuck in `SUBMITTED`, accounts requiring documents with none).
- Blocking vs non-blocking items; waivers require a reason and an approver.
- Period close → lock; year-end process producing closing balances and retained-earnings movement.
- Adjustment periods for post-close adjustments (PDF §63).
- Reopen flow: request → **CEO approval** → audited `PERIOD_REOPENING` → `reopenCount` incremented.
- Final close with **CEO sign-off** where configured (PDF §64).
- Close reports and a close summary document.

**DB changes:** `financial_closes`, `close_checklist_items`; `financial_periods` lock/reopen/sign-off fields.

**API routes:** CRUD `/api/v1/closes`, `/closes/:id/items/:itemKey/check|waive`; `POST /closes/:id/submit`, `/closes/:id/sign-off`; `POST /periods/:id/close|lock`, `/periods/:id/year-end`, `/periods/:id/reopen-request`, `/periods/:id/reopen-approve`, `/periods/:id/create-adjustment-period`.

**UI screens:** `/close` (checklist), `/close/[id]`, `/periods/[id]/close`, `/periods/[id]/reopen`, `/periods/[id]/year-end`.

**Tests:** close blocked while any blocking item is failing; waiver requires a reason and is audited; automated checks produce correct figures; posting is blocked after lock; **reopen requires CEO approval and is audited**; year-end produces balanced closing balances and a retained-earnings movement; adjustment period allows post-close posting only in the adjustment period; CEO sign-off records signer and timestamp; reopen counter increments.

**Definition of done:** a month cannot close while reconciliations are outstanding; a locked period rejects posting at the database; reopening requires CEO approval and leaves a permanent audit record; year-end balances; "how to verify" note written.

---

### M16 — Dashboards, Notifications, Global Search, Anomaly Detection

**Goal:** The CEO and Finance Officer dashboards (PDF §48), in-app + email notifications (PDF §46), permission-aware search (PDF §53), and flag-only anomaly detection (PDF §65).

**Deliverables**
- **CEO dashboard:** current cash, bank balance, revenue, expenses, profit/loss, outstanding receivables, payables, budget utilization, funding, pending approvals, risks, compliance alerts. (Runway/forecast shown as declared-unavailable in Phase 1 rather than faked.)
- **Finance Officer dashboard:** transactions awaiting action, reconciliation status, unpaid invoices, supplier bills, cash position, budget alerts, missing documents, financial close status, pending approvals, recent transactions.
- Project performance panel (Iventika, Uzanite) from the lightweight project dimension.
- Notifications: in-app + email; preferences, categories, quiet hours, dedupe keys; reminder jobs (approvals, budget alerts, payment reminders, compliance, document expiry, close deadlines).
- Global search across transactions, customers, suppliers, projects, invoices, documents, budgets — **permission-aware at the query level**, not by post-filtering results.
- Anomaly detection: **deterministic rule engine** (duplicates, round-number clustering, weekend/late-night entries, amount outliers, SoD near-misses, budget abuse patterns, supplier-detail-changed-then-paid, unusual login activity). Flags only — never blocks, never decides, no `accusedUserId`. AI suggestion adapter interface stubbed for Phase 3.
- Anomaly triage UI: acknowledge / dismiss with reason / confirm; each action audited.

**DB changes:** `anomaly_flags`, `security_events` (already present) — completed here.

**API routes:** `GET /api/v1/dashboard/ceo`, `/dashboard/finance`; `GET/POST /api/v1/notifications`, `/notifications/:id/read`, `/notification-preferences`; `GET /api/v1/search?q=&type=`; `GET /api/v1/anomalies`, `POST /anomalies/:id/acknowledge|dismiss|confirm`, `POST /anomalies/scan`.

**UI screens:** `/dashboard/ceo`, `/dashboard/finance`, `/notifications`, `/admin/anomalies`, global search palette (⌘K).

**Tests:** dashboard figures equal the underlying reports; **search never returns a record the user cannot view** (test with a dimension-scoped role); notification dedupe prevents storms; preference changes take effect; quiet hours respected; the supplier-detail-changed-then-paid rule fires; **no anomaly path can block a payment or alter a record without a named human acknowledging it**; dismissing requires a reason; every triage action is audited.

**Definition of done:** both dashboards show correct figures; notifications reach the right people without duplicates; search respects scope; anomalies are flagged and triaged with a human in the loop and no AI decision; "how to verify" note written.

---

### M17 — PWA/Offline, Backups & DR, Security Hardening, Documentation, Go-Live Migration

**Goal:** Make the system production-ready: offline receipt capture (PDF §58), backups and DR (PDF §57), security hardening (PDF §55/§56), documentation (PDF §61), and the historical data migration (PDF §2).

**Deliverables**
- **PWA:** installable manifest, service worker, offline fallback shell.
- **Offline receipt capture** with local queue and IndexedDB storage; **allowlisted actions only** (`RECEIPT_CAPTURE`, `DRAFT_SAVE`, `CONTACT_CARD_SAVE`).
- Sync engine with client idempotency keys, duplicate prevention, per-item conflict descriptors and resolution strategies (`CLIENT_WINS` / `SERVER_WINS` / `MANUAL`).
- **Approvals and posting are refused offline** — client-side affordance *and* a distinct server error code.
- **Backups:** automated schedule, multiple storage locations, encryption, monitoring, verification job, point-in-time recovery where the provider supports it.
- **Restoration testing** — a documented, actually-executed restore drill with a recorded result.
- DR procedures and recovery documentation.
- Security hardening: TLS everywhere, encryption at rest, secret management, rate limiting on sensitive endpoints, secure upload validation, backup protection, security monitoring dashboards, vulnerability management (dependency scanning in CI), incident response runbook and a rehearsed incident drill.
- **Data privacy (PDF §56):** data classification, retention controls, controlled deletion, breach procedure — **flagged for legal review, never asserted as legally compliant**.
- Documentation set: architecture, schema, runbooks (backup-restore, period close/reopen, incident response, access review, rollback), OpenAPI, ADRs.
- **Go-live historical migration:** import BLECA's existing incomplete records through the seven-stage pipeline with `isUnverified = true`, including the bootcamp revenue figure, preserving original information, source, import date, verification status and migration history.
- Full E2E suite across all critical flows; performance check on dashboards and reports.

**DB changes:** `backup_runs`, `sync_queue_items`; possible `account_balance_snapshots` rebuild.

**API routes:** `POST /api/v1/sync/batch` (allowlisted actions only); `GET /api/v1/sync/conflicts`; `POST /api/v1/backups/run|verify|restore-test`; `GET /api/v1/security/events`, `/health`.

**UI screens:** `/offline` (capture + queue), `/admin/backups`, `/admin/security-events`, `/admin/imports` (historical migration), `/settings/privacy`.

**Tests:** offline receipt captured and synced without duplication; **an offline approval attempt is refused server-side**; conflict resolution preserves both records and audits the resolution; backup completes, verifies and restores into a clean database with a recorded result; rate limiting trips and is audited; the audit chain still verifies after all operations; **full E2E: auth → transaction lifecycle → approval → posting → reversal → reconciliation → close → reopen**; migration of the historical dataset produces correct, visibly unverified figures.

**Definition of done:** the system is installable and captures receipts offline without duplicating them; approvals cannot be made offline; a backup has been verified by an actual restore; the full E2E critical flow passes; the historical data is migrated and correctly marked unverified; documentation and runbooks exist; "how to verify" note written.

---

### Milestone dependency order

```
M1 ──► M2 ──► M3 ──► M4 ──► M5 ──► M6
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        ▼                         ▼                         ▼
       M7 ──► M8                M9                        M12
        │                                                   │
        └──────────────┬────────────────────────────────────┘
                       ▼
              M10 ──► M11 ──► M13
                       │
                       ▼
              M14 ──► M15 ──► M16 ──► M17
```

M7–M13 are largely parallelisable once M6 lands, but I will build them **in the order above**, stopping after each for your verification.

---

## 9. Risks and Open Questions

### 9.1 Open Questions — ANSWERED

> **Status: all 12 questions answered by the CEO. The plan is approved in principle. No application code has been written and none will be written until the CEO sends the literal instruction "start M1".**
>
> Answers recorded below verbatim in intent. Each answer is followed by the **design consequence** it locks in and the **milestone** it lands in. Placeholders the CEO left unfilled are marked **OPEN-STILL** and are carried forward as tracked items, not assumed.

---

**Q1 — Notifications and Compliance: Phase 1 or Phase 2?** — **ANSWERED**

> *Answer:* Phase 1 minimum = **in-app + email notifications, configurable tax engine**. **Defer SMS/push and advanced compliance to Phase 2.**

**Consequence:** `NotificationChannel` keeps `SMS` and `PUSH` in the enum (architected, not wired) and M16 ships `IN_APP` + `EMAIL` as the only live channels. The tax engine is built fully configurable in M13 with **no** Tanzanian rates hardcoded — VAT and withholding rules are created as *unverified configuration rows* awaiting accountant sign-off (see Q6). Advanced compliance workflows (filing calendars, e-filing integration, obligation tracking beyond the ledger) move to Phase 2.
*Affects:* M13, M16.

---

**Q2 — Approval amount thresholds.** — **ANSWERED**

> *Answer:* **All amounts require CEO approval in Phase 1. No auto-approve band.**

**Consequence:** `ApprovalPolicy` seeds exactly one amount rule: `AMOUNT_GREATER_THAN = 0`. Every `TRANSACTION`, `JOURNAL_ENTRY`, `INVOICE`, `PAYMENT`, `RECEIPT`, `ADJUSTMENT`, `REVERSAL`, `CREDIT_NOTE`, `PERIOD_REOPEN` and `SUPPLIER_BANK_DETAIL_CHANGE` routes to the CEO as final approver. `Role.maxApprovalAmount` exists in the schema but is **not** used to create an implicit band. Any future threshold is a *configuration change* (audited as `CONFIGURATION_CHANGES`), never a code change.
*Affects:* M6, and is load-bearing for M5 and M7–M13.

---

**Q3 — Can the CEO also post transactions?** — **ANSWERED**

> *Answer:* **Option (b)** — the CEO can prepare **and** post small personal items with a **recorded waiver**, flagged as an **SoD exception on the dashboard**.

**Consequence:** the kernel invariant "posting user ≠ submitting user" (§2.3.4) gains one explicitly permitted exception path, gated on all of:
1. actor holds `isFinalApprover` (CEO),
2. the record is flagged `isPersonalItem = true`,
3. a `SodWaiver` row is written in the **same** transaction as the posting, with `reason`, `amount`, `currency` and timestamp,
4. an `AuditAction.SOD_VIOLATION_ATTEMPT`-class `SECURITY_EVENT` is raised — but with severity `INFO`, because this is a *sanctioned* waiver, not an attack,
5. the item appears on the CEO dashboard under **"Segregation-of-Duties Exceptions"** and appears in every management report.

The waiver is **per-record, not a standing bypass**: there is no role flag that disables SoD, and no bulk auto-post path. Any personal item that is *not* waived still fails the posting invariant.
*Affects:* M5 (state machine), M6 (waiver record + approval policy), M16 (dashboard tile).

---

**Q4 — How lightweight is the Phase 1 `Project` dimension?** — **ANSWERED**

> *Answer:* **Lightweight** — code, name, owner, status, dates, budget link, revenue/expense roll-up. **No tasks/milestones in Phase 1.**

**Consequence:** the `Project` model as drafted in §3.2 is correct as-is — no schema change needed. Iventika and Uzanite seed as real projects. Revenue/expense roll-up is a **derived** view over `JournalLine`, not a stored column, so it can never drift from the GL. Tasks, milestones, deliverables, KPIs and risks (PDF §33) are **out of Phase 1** and the `PROJECTS_FULL` module key already reserved in `ModuleKey` covers them.
*Affects:* M2.

---

**Q5 — Historical opening balances: what exists?** — **PARTIALLY ANSWERED — OPEN-STILL**

> *Answer as given:* "We have the bootcamp invoices, some M-Pesa screenshots, and a partial Excel cash book. No formal bank statements yet." *(CEO left this bracketed as a template — recorded verbatim; confirm it is the actual state.)*

**Consequence:** M17 migration is **largely manual** and the dominant constraint is *evidence quality*, not volume. Specifically:
- **M-Pesa screenshots are images, not data.** They are usable as *supporting documents* only — they cannot be reconciled as transaction records. Reconciliation against mobile money in M8 must therefore begin from *transactions entered in-app*, not from an imported statement.
- **No bank statements** means the first CRDB/NMB reconciliation will be a **baseline** session: you establish the opening balance from the app's own records and reconcile forward from the date the statements begin, not a back-fill. This is recorded as an explicit `ReconciliationStatus`/`CloseItemKey.GO_LIVE_CLEANUP` item.
- The **partial Excel cash book** is the only machine-readable source → the seven-stage import pipeline (§2.4, detail #7) has exactly one real input at go-live.
- The ~TZS 3,900,000 bootcamp figure with its *known-incomplete* expense side must be imported as a **one-sided, partially-entered position with `verificationStatus = UNVERIFIED`**, and must render as visibly unverified in every report (Risk R1). I will not present it as a closed result.
- Screenshots carry PII and financial data — they need a documented redaction and retention decision before upload.

**Still needed from the CEO (does not block M1):** confirm the bracketed text is the real state; the location and rough row count of the Excel cash book; how many bootcamp invoices exist and whether they carry TIN/numbering.
*Affects:* M8, M17.

---

**Q6 — Which Tanzanian tax regime applies, and who verifies it?** — **ANSWERED (tax scope) / OPEN-STILL (accountant identity)**

> *Answer:* **VAT + withholding tracked at go-live.** Qualified accountant: **[TBD — will engage before go-live]**. The CEO acknowledges that I will not provide tax advice.

**Consequence:** I will not opine on rates, thresholds, applicability, or filing obligations — those are legal and tax matters. What I build is the **engine**, configured from data:
- `TaxRule` rows for VAT and withholding are created with `verificationStatus = PENDING_VERIFICATION` and **no rate value assumed**. A rate-less rule is inert: the engine refuses to compute and raises an explicit missing-configuration error rather than defaulting to 0% or a guess.
- VAT handling is governed by `TaxCalculationBasis` (`EXCLUSIVE` / `INCLUSIVE` / `NOT_APPLICABLE`), which is the real-world VAT dispute line — so the basis is a stored, per-rule decision an authorised user makes, not an assumption I bake in.
- Because BLECA is **not yet registered** (PDF §2), `TaxObligationStatus.NOT_APPLICABLE` is the correct default and `Organization.tin` stays nullable. Tax configuration can exist and be recorded before registration takes effect.
- `TIN` is never hardcoded and never guessed.

**Still needed from the CEO (does not block M1, blocks M13 go-live sign-off):** the accountant's name, so the CoA and tax-rule verification records name a real human rather than a placeholder.
*Affects:* M3 (CoA verification), M13.

---

**Q7 — Does the Finance Officer need a scope beyond Mbeya?** — **ANSWERED**

> *Answer:* **Finance Officer scoped to Mbeya; CEO unrestricted.**

**Consequence:** `RoleScopeGrant` is **actively configured**, not merely available. The Finance Officer role ships with `Location` dimension grants limited to the Mbeya location (and its `includeChildren = true`, so sub-sites inherit), plus department grants for the finance department. The CEO role carries **no** `RoleScopeGrant` rows — unrestricted is expressed as the *absence* of a narrowing grant, and the authorization layer treats an absent grant on a given dimension as "all values" for `isFinalApprover` roles only.
- Mbeya seeds as a `Location` of type `UNIVERSITY_FACILITY` with a `permissionReference`, per PDF §2 (permitted use, not owned premises).
- **Scope is enforced server-side in `authorize()`**, never by hiding UI. A Finance Officer requesting an out-of-scope record gets a distinct `SCOPE_VIOLATION` denial — logged as `SecurityEventType.PERMISSION_DENIED_SPIKE` candidate and audit `ACCESS_DENIED` — not a silent empty list.
*Affects:* M2, M6.

---

**Q8 — Bank statement format(s).** — **PARTIALLY ANSWERED — OPEN-STILL**

> *Answer as given:* "[e.g., CRDB, NMB, M-Pesa, Airtel Money]. I will share redacted samples before M8." *(CEO left the provider list bracketed as a template.)*

**Consequence:** unchanged from the proposal — **no hardcoded bank parsers**. Bank/mobile-money formats are `ImportMapping` configuration rows, so adding a provider is data, not a deploy. Combined with Q5 (no statements exist yet), the M8 dependency is a hard gate: **I will not build reconciliation against a guessed file shape.** Redacted samples are required before M8 begins.
**Still needed from the CEO (blocks M8):** the actual provider list and two redacted sample statements per provider.
*Affects:* M8.

---

**Q9 — Invoice/quotation numbering and tax-invoice validity.** — **ANSWERED**

> *Answer:* **Strict sequential numbering, gap-detected, gaps logged as security events.**

**Consequence:** numbers are allocated from a **gapless, strictly increasing** series per document type per organization. The system will **not** reuse a number after cancellation — the number is burned and the void is recorded, because a reused tax-invoice number is the actual fraud risk. Gap detection is continuous (last-issued vs. max-issued comparison) and any gap raises `SecurityEventType` of the appropriate class with `AuditAction.SECURITY_EVENT`, at `MEDIUM` or above.
- Any prefix or format string is **configuration**, not code, so the format can be set to whatever the accountant/authority requires without a migration.
- Number allocation is transactional with issuance, so two concurrent issuances cannot collide (unique constraint is the backstop).
*Affects:* M11.

---

**Q10 — Offline scope.** — **ANSWERED**

> *Answer:* **Confirmed** — offline allowlist = **receipt capture + draft save + contact cards only**.

**Consequence:** the `SyncActionType` allowlist is exactly `RECEIPT_CAPTURE`, `DRAFT_SAVE`, `CONTACT_CARD_SAVE`. `SUBMIT`, `APPROVE`, `REJECT`, `POST`, `REVERSE`, `PERIOD_CLOSE`, `PERIOD_REOPEN` are **structurally excluded** — not blocked by UI, absent from the offline queue type entirely, and rejected server-side with a distinct error code if replayed. Client-generated idempotency keys preserve duplicate prevention across sync.
- Because Q2 requires CEO approval on *every* amount, and approval is online-only, **nothing financial can reach the ledger while offline.** This is the intended behaviour, not a limitation to work around.
*Affects:* M17.

---

**Q11 — Email delivery.** — **PARTIALLY ANSWERED — OPEN-STILL**

> *Answer as given:* "[Resend for production, Mailpit for local dev] OR [Zoho Mail] OR [Please build against generic SMTP + Mailpit default]". *(CEO left the options bracketed and did not select one.)*

**Consequence:** email is behind a **`MailProvider` interface** regardless of the choice, so swapping providers is a config change and no business logic depends on it. **My recommendation: generic SMTP + Mailpit default for local dev** — it is the least vendor-coupled option and the one that will not need reworking if a provider is later replaced. If Resend or Zoho is chosen instead, the adapter is a single file.
**No credentials will be committed** — env vars only, `.env.example` documents every variable.
**Still needed from the CEO (blocks M16):** select one of the three options. Does not block M1.
*Affects:* M16.

---

**Q12 — Hosting choice: Neon or Supabase Postgres, and S3-compatible storage?** — **ANSWERED**

> *Answer:* **Supabase Postgres. Storage abstracted so Neon + S3 is a config change.**

**Consequence:** `DATABASE_URL` and the storage driver are environment configuration; `lib/documents` depends on a `StorageDriver` interface with a Supabase driver as the default implementation. No Postgres-specific SQL will be written that has no portable equivalent, so the Neon migration path stays open. PITR is a Supabase responsibility (Risk R13: backup verification and a real restore drill remain **BLECA's** obligation — the vendor's backup is not a verified backup).
*Affects:* M17, and every migration from M1 onward (schema portability is a constraint on all of them).

---

#### 9.1.1 Answers still outstanding (carried forward, none block M1)

| Ref | Item needed | Blocks | Needed by |
|---|---|---|---|
| Q5 | Confirm actual historical-record inventory; Excel cash book location + size; bootcamp invoice count and whether they carry TIN/numbering | M8, M17 | Before M8 |
| Q5 | Redaction + retention decision for M-Pesa screenshots (PII + financial data) | M12, M17 | Before M17 |
| Q6 | Qualified accountant's **name** — needed on CoA and tax-rule verification records | M13 | Before M13 |
| Q8 | Actual bank/provider list + two redacted sample statements each | M8 | Before M8 |
| Q11 | Email provider selection | M16 | Before M16 |

None of these change the schema or block M1. I will re-raise each one at the milestone that needs it rather than guessing.

---

### 9.1.A — Original questions (superseded, retained for traceability)

**Q1 — Notifications and Compliance: Phase 1 or Phase 2?**
The PDF's phase table puts Notifications and Compliance in **Phase 2** (PDF §71), but `BUILD_PROMPT.md` §5 requires **notifications (in-app + email)** and a **configurable tax engine** as Phase 1 support items. The PDF body (§46, §32) states both as unconditional "shall" requirements.
*My proposal:* build in-app + email notifications and the configurable tax engine in Phase 1 (minimum viable), and defer SMS/push, advanced compliance workflows and notification digests to Phase 2.
*Impact if wrong:* M13 and part of M16 move scope. **Please confirm.**

**Q2 — Approval amount thresholds.**
The spec never states monetary thresholds. My proposal for Phase 1: **every** transaction, invoice, payment and adjustment requires CEO approval, with no low-value auto-approve band — simplest and safest for a 2-person organisation.
*Please confirm, or give the thresholds you want.*

**Q3 — Can the CEO also post transactions?**
Segregation of duties says the preparer cannot approve their own submission. But with only two Phase 1 users, if the CEO personally enters a transaction, strictly applying the rule makes it impossible to post.
Options: (a) CEO prepares, Finance Officer approves — contradicts "CEO has final authority"; (b) CEO can prepare-and-post small personal items with a recorded waiver and mandatory disclosure in the audit trail; (c) CEO prepares, CEO approves as a documented exception flagged as a SoD exception.
*My proposal:* (b) — recorded, audited, visible on the dashboard as a standing SoD exception. **Please choose.**

**Q4 — How lightweight is the Phase 1 `Project` dimension?**
`BUILD_PROMPT.md` says "lightweight — beyond dimension". The PDF §33 lists teams, objectives, tasks, milestones, deliverables, KPIs, risks. I plan: **code, name, owner, status, dates, budget link, revenue/expense roll-up** — no tasks or milestones.
*Please confirm*, or tell me which §33 fields are needed in Phase 1.

**Q5 — Historical opening balances: what exists?**
To import BLECA's incomplete records correctly I need to know roughly what you have today: bank statements, cash books, mobile-money records, the bootcamp invoice(s), any spreadsheets.
*This is a data-collection question, not a design question* — but it determines how much of M17's migration is manual.

**Q6 — Which Tanzanian tax regime applies, and who verifies it?**
The spec forbids hardcoded Tanzanian tax values and requires accountant verification of the CoA (PDF §7) and tax rules (PDF §32). I will build the engine fully configurable and record verification status.
*Questions:* Do you want VAT, withholding, income tax or turnover tax tracked at go-live? Who is the qualified accountant for CoA and tax-rule sign-off? *Note: these are legal/tax matters — I will not provide tax advice; the system will only record what an authorised user configures.*

**Q7 — Does the Finance Officer need a scope beyond Mbeya?**
Is the Finance Officer responsible for all locations, or scoped to Mbeya with the CEO seeing everything? This determines whether dimension scoping is configured or merely available.
*My proposal:* Finance Officer scoped to their assigned locations/departments; CEO unrestricted. **Please confirm.**

**Q8 — Bank statement format(s).**
Reconciliation and import depend on the real file shapes. Which banks/mobile-money providers, and can you share two redacted sample statements?
*No hardcoded bank parsers will be built* — mappings are configuration (PDF §11 "architecture shall later support direct bank APIs").

**Q9 — Invoice/quotation numbering and tax-invoice validity.**
Do invoices need to be sequential with gaps blocked, and does a tax invoice number need a particular format? The PDF requires tax-invoice support but no numbering scheme.
*My proposal:* strict sequential, gap-detected, gaps logged as security events. **Please confirm.**

**Q10 — Offline scope.**
`BUILD_PROMPT.md` §3 lists offline receipt capture, queued non-critical actions, sync and conflict resolution. My allowlist is receipt capture + draft save + contact cards.
*Please confirm* that anything else (e.g. expense claims by team members — PDF §39) is out of Phase 1 scope, since it would require new roles.

**Q11 — Email delivery.**
Notifications need an email provider. Do you have one (or should I build against a generic SMTP/API adapter with a local Mailpit default)?
*No credentials will be committed; env vars only.*

**Q12 — Hosting choice: Neon or Supabase Postgres, and S3-compatible storage?**
`BUILD_PROMPT.md` §3 allows either and requires pluggable file storage. Point-in-time recovery (PDF §57) differs between them.
*My proposal:* Supabase Postgres (PITR + storage in one vendor, lower ops burden for 2 users) with the storage layer abstracted so Neon + S3 is a config change. **Please confirm** — this affects M17.

### 9.2 Technical Risks and Mitigations

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R1 | **Unverified historical data leaks into "accurate" reporting.** A partial bootcamp figure could be read as a closed result. | Severe — violates the core principle and PDF §2. | `isUnverified` defaults to `true` on opening balances; unverified amounts are visually marked in every report; M14 has a regression test asserting the marker; verification is an explicit, audited action with notes. |
| R2 | **Posting bypass through direct DB access or a buggy service.** | Severe — silent ledger corruption. | DB triggers (immutability, period lock, balance); `REVOKE UPDATE, DELETE` on audit; tenant extension; no production data access outside the application; integration tests that attempt bypass and expect failure. |
| R3 | **Rounding drift between documents and the ledger** (tax, allocation, FX). | High — reports stop tying to the GL. | `Decimal(20,6)` everywhere; configurable per-currency rounding mode; document totals computed server-side and never trusted from the client; reconciliation tests tying each document to its journal entry. |
| R4 | **Cross-currency complexity** (rates, differences, historical rates). | High — misstated financials. | Transaction-date rate lookup with an explicit missing-rate error (never a silent fallback); FX differences routed to a configured treatment account; base-currency amounts stored alongside originals; multi-currency report shows both plus the rate and date used. |
| R5 | **Reconciliation matching produces wrong matches**, silently corrupting the bank position. | High. | Auto-matches are **proposals** requiring human confirmation; confidence thresholds are configurable; partial and one-to-many handled explicitly; unmatched items always visible; session cannot be approved with a non-zero unexplained difference. |
| R6 | **Import corrupts the ledger** (wrong mapping, wrong period, duplicates). | High. | Seven gated stages; preview must match the committed result exactly (tested); file-hash dedupe; row-level fingerprints; error queue; full rollback; human approval required before commit. |
| R7 | **Budget bypass** (posting without a budget, or bypassing the over-budget gate). | High. | Availability recomputed in the same transaction as posting; over-budget posts require an approved `OVER_BUDGET` condition; negative available is impossible at the DB level (check constraint). |
| R8 | **Scope creep.** The PDF describes 76 sections; Phase 1 is 27 items. | High — schedule and quality. | Explicit in/out-of-scope lists; Phase 2+ module keys exist as placeholders only; the "module unavailable" gate reports Phase 2 reports honestly rather than half-building them; new scope requires your explicit approval. |
| R9 | **Two-person team key-person risk.** | Medium. | Delegation and temporary access with mandatory expiry; access reviews; documented runbooks; MFA enforced for both roles. |
| R10 | **PWA offline conflicts corrupt financial data.** | High. | Allowlisted offline actions only; server refuses approvals/posting offline; client idempotency keys; conflict descriptors returned per item; sync writes `channel = SYNC` in the audit trail for later review. |
| R11 | **Tax configuration errors** (wrong rate or wrong applicability) produce wrong invoices. | High — legal exposure. | Rates are data with a verification trail; tax invoices are validated before issue; a compliance warning surfaces unverified rules; accountant sign-off is tracked. |
| R12 | **Data protection compliance over-claimed.** | Medium — legal. | The system records controls; it does not assert legal compliance. PDF §56 requirements are flagged for legal review in `docs/data-protection.md` and treated as an open item (Q6). |
| R13 | **Backup exists but is not restorable.** | Severe. | Verified backups plus an actually executed restore drill recorded in `backup_runs.restoreTestedAt`; M17 requires the drill, not just the policy. |
| R14 | **AI pressure to "just auto-approve".** | Severe — violates PDF §30/§65. | AI adapters are interfaces with no write access to financial state; anomaly flags carry no `accusedUserId` and no blocking effect without human acknowledgement; tests assert AI cannot approve, post, transfer or delete. |
| R15 | **Reports silently omit unverified data**, or show it as fact. | High. | Reports are marked where unverified data is included; registry declares unavailable reports; each report has a tie-out test against the GL. |
| R16 | **MFA and session hardening is weakened for convenience** (e.g. disabling MFA, long-lived sessions). | High. | MFA enforced for CEO and Finance Officer by default and non-bypassable; timeouts configurable via `AuthPolicy` with sane defaults; weakening a control is itself an audited configuration change. |

### 9.3 Assumptions I have made (flagging rather than hiding)

1. **Single organisation.** `OrganizationType.SINGLE_ENTITY`. Multi-entity is Phase 4, but `organizationId` is on every table so it is additive later.
2. **Fiscal year = calendar year** until told otherwise; configurable per organisation.
3. **English-only UI** with an i18n structure ready for Swahili (PDF page 1 lists Swahili as a secondary language).
4. **No Tanzanian tax or banking constants in code.** Everything tax is data; bank formats are configurable mappings.
5. **Destructive financial actions are limited to adjustment/reversal**, never edit or delete of approved records.
6. **The Engineer (CEO) is the only user who can deploy**, and no one edits production data outside the application — per `BUILD_PROMPT.md` §10 and PDF §61.

---

## 10. Approval Statement

I have read `BLECA_SMARTLABS_financial_website_requirements.pdf` in full (all 57 pages, Sections 1–76) and `BUILD_PROMPT.md` in full.

**This document is a plan only. No application code has been written. Nothing has been scaffolded. No repository has been created. The only file I have written is this `PHASE_1_PLAN.md`.**

**I will not write any application code until you explicitly approve this plan.**

> **Update:** the plan was **approved in principle** and all twelve §9.1 questions were answered. The answers, their design consequences and the five items still outstanding (Q5 evidence inventory, Q5 screenshot redaction, Q6 accountant name, Q8 bank samples, Q11 email provider) are recorded in **§9.1** and **§9.1.1**. **No application code has been written and none will be written until the CEO sends the literal instruction "start M1".**

When you approve, I will build **Milestone 1 only** — repo scaffold + authentication + database schema + base RBAC + audit log foundation — and then **stop** so you can test it, exactly as `BUILD_PROMPT.md` §13 requires. Each milestone will ship with code, migrations, tests and a short "how to run / how to verify" note.

**Milestone gate:** M1 only, on the word "start M1". No M2 work. No speculative work on later milestones. I stop after M1 for your verification.

<!-- END OF PLAN -->