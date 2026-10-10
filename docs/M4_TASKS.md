# M4 Sub-tasks

**Goal:** Double-Entry Core, General Ledger, Trial Balance, Financial Statements.

---

1. **Prisma models + migrations for M4 core tables**
   - Models: `JournalEntry` (type, status, source, period, number, submittedBy, approvedBy, postedBy, approvedAt, postedAt, reversedBy, reversedAt, reversalReasonId, adjustingEntryId), `JournalLine` (entry, account, description, debit, credit, currency, baseAmount, project, department, costCentre, location, fundingSource), `AccountBalanceSnapshot` (rebuildable cache), `ReversalReasonCode`.
   - Raw SQL: balance trigger enforcing `sum(debits) = sum(credits)` per entry; immutability trigger rejecting `UPDATE`/`DELETE` on `journal_entries` and `journal_lines` when `status IN ('POSTED','LOCKED')`.
   - Seed: default reversal reason codes per `ReasonCodeCategory`.

2. **API routes: Journal Entries CRUD + lifecycle**
   - `GET/POST /api/v1/journal-entries` (list with filters, create with live balance indicator).
   - `GET/PATCH /api/v1/journal-entries/[id]` (detail, update only while `DRAFT`).
   - `POST /api/v1/journal-entries/[id]/submit` (status `DRAFT` → `SUBMITTED`, SOD: submitter ≠ poster).
   - `POST /api/v1/journal-entries/[id]/approve` (status `SUBMITTED` → `APPROVED`, requires approval policy satisfied).
   - `POST /api/v1/journal-entries/[id]/post` (status `APPROVED` → `POSTED`, runs `lib/accounting/posting.ts`: balance check, period `OPEN` check, SOD check, approval check, account lock check, number allocation, base-currency computation).
   - `POST /api/v1/journal-entries/[id]/reverse` (creates linked opposite entry, original stays visible; full/partial with reason code + evidence).
   - `POST /api/v1/journal-entries/[id]/adjust` (creates correcting entry linked to original).
   - `POST /api/v1/journal-entries/[id]/void` (voids draft/submitted only).
   - All routes: `JOURNAL_ENTRIES` module, actions per state, idempotency key, audit.

3. **Posting engine (`lib/accounting/posting.ts`)**
   - `postJournalEntry(entryId, context)` — single entry point for all posting.
   - Validations: balanced (`sum(debits) === sum(credits)`), period `OPEN`/`REOPENED`, submitter ≠ poster, approval policy satisfied, all accounts `POSTABLE` and active/locked-but-approved, single currency per entry (multi-currency split with FX difference entry).
   - Number allocation (sequential per period with gap detection).
   - Base-currency computation using `lib/fx` at posting date.
   - Writes `JournalLine` + updates `AccountBalanceSnapshot` in same transaction.
   - Returns posted entry with lines and balances.

4. **API routes: General Ledger + Trial Balance**
   - `GET /api/v1/general-ledger` (params: accountId, periodId, startDate, endDate, projectId, departmentId, costCentreId, locationId, fundingSourceId, currency; returns lines with running balance).
   - `GET /api/v1/trial-balance` (params: asAtDate, currency, includeZeroBalances; returns account, type, debit, credit, baseCurrencyDebit, baseCurrencyCredit; debits = credits).
   - `GET /api/v1/general-ledger/account/[id]` (account statement with opening/closing balance, running total).

5. **API routes: Financial Statements**
   - `GET /api/v1/reports/income-statement` (params: periodId, startDate, endDate, projectId, departmentId, costCentreId, fundingSourceId, currency, comparativePeriodId; returns revenue by subcategory, expense by subcategory, net surplus/deficit).
   - `GET /api/v1/reports/balance-sheet` (params: asAtDate, currency, comparativeDate; returns assets by subcategory, liabilities by subcategory, equity by subcategory; assets = liabilities + equity).
   - `GET /api/v1/reports/cash-flow` (params: periodId, startDate, endDate; indirect method per PDF §47: operating/investing/financing, reconciles to cash movement).

6. **AccountBalanceSnapshot rebuild job**
   - `POST /api/v1/admin/rebuild-balance-snapshots` (truncates `account_balance_snapshots`, recomputes from `JournalLine` for all accounts/periods/currencies/dimensions; idempotent, audited).
   - Background job / scheduled task support (cron).

7. **UI screens: Journal Entries**
   - `/accounting/journal-entries` (list with filters, status badges, pagination).
   - `/accounting/journal-entries/new` (form with line editor, live debit/credit balance indicator, dimension pickers, validation inline).
   - `/accounting/journal-entries/[id]` (detail: lines, audit trail, status timeline, actions per state: submit/approve/post/reverse/void/adjust).
   - `/accounting/journal-entries/[id]/reverse` (modal: reason code, evidence, full/partial amount).

8. **UI screens: GL, Trial Balance, Financial Statements**
   - `/accounting/general-ledger` (filters, dimension breakdown, running balance, export CSV).
   - `/accounting/trial-balance` (as-at date picker, multi-currency toggle, base-currency column, debits=credits badge).
   - `/reports/financial/income-statement`, `/reports/financial/balance-sheet`, `/reports/financial/cash-flow` (period selectors, comparative view, drill to GL, export PDF/CSV).

9. **Integration tests + verification doc**
   - Tests: unbalanced entry cannot post; locked-period post rejected by trigger; poster ≠ submitter rejected; posting without approval rejected; posted entry `UPDATE`/`DELETE` rejected by trigger; reversal produces linked opposite entry, original visible; partial reversal residual balance correct; trial balance debits = credits; balance sheet balances; income statement ties to GL; snapshot truncation + rebuild reproduces identical figures.
   - Write `docs/M4_VERIFICATION.md` with step-by-step verification (balanced journal post, locked-period rejection, posted immutability, reversal traceability, trial balance, statements tie to GL).