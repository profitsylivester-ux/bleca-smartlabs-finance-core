# M3 Sub-tasks

**Goal:** Configurable Chart of Accounts (PDF §7), Financial Period management, and Opening Balances with unverified flag support.

---

1. **Prisma models + migrations for M3 core tables**
   - Models: `Account` (hierarchical, type, normal balance, postable/lockable, reconcilable, document-required, `validatedByQualifiedAccountant`), `FinancialPeriod` (type, status, auto-generation, `reopenCount`, adjustment period flag), `OpeningBalance` (account, period, amount, `isUnverified` default true, `verificationStatus`, `source`), `AccountBalanceSnapshot` (rebuildable cache).
   - Raw SQL: period-lock trigger on `journal_entries` + `transactions` rejecting writes when period status = `LOCKED`.
   - Seed: Full PDF §7 CoA including dormant Phase 2 accounts (`INVENTORY`, `EQUIPMENT`, `FUTURE_INVESTMENT`, SaaS/token/component revenue, salaries, hardware/prototyping).

2. **API routes: Chart of Accounts CRUD + PDF §7 seed endpoint**
   - `GET/POST /api/v1/accounts` (hierarchical list + create with validation: unique code per org, parent must exist, normal balance per type).
   - `GET/PATCH/DELETE /api/v1/accounts/[id]` (no delete if lines exist; lock instead).
   - `POST /api/v1/accounts/seed-pdf7` (idempotent, runs the exact PDF §7 seed).
   - All routes: `MASTER_DATA` module, `CREATE/EDIT/VIEW` actions, idempotency key, audit.

3. **API routes: Financial Periods lifecycle + auto-generation**
   - `GET/POST /api/v1/periods` (list/create).
   - `POST /api/v1/periods/[id]/open`, `POST /api/v1/periods/[id]/close`, `POST /api/v1/periods/[id]/lock` (status transitions with validations).
   - `POST /api/v1/periods/[id]/reopen-request` (creates approval request), `POST /api/v1/periods/[id]/reopen-approve` (increments `reopenCount`, sets `REOPENED`).
   - `POST /api/v1/periods/generate-fy` (auto-generates monthly/quarterly/annual periods for a fiscal year without overlap).
   - All transitions audited; locked-period writes rejected by DB trigger.

4. **API routes: Opening Balances + verification**
   - `GET/POST /api/v1/opening-balances` (create with `isUnverified: true` default, `verificationStatus: UNVERIFIED`, `source` required).
   - `POST /api/v1/opening-balances/[id]/verify` (requires `verifiedByQualifiedAccountant` note, sets `verificationStatus: VERIFIED`, `isUnverified: false`).
   - Cannot post opening balance to a non-postable account; cannot create without `source` field.

5. **UI screens + integration tests + verification doc**
   - `/accounting/chart-of-accounts` (tree view with expand/collapse, account detail drawer).
   - `/accounting/opening-balances` (list with unverified badge, verify action).
   - `/periods` (list with status badges, actions), `/periods/[id]` (detail + reopen flow).
   - Tests: account code uniqueness; cannot post to non-postable account; period auto-generation covers year without overlap; posting into LOCKED period rejected by **trigger**; reopen requires approved request + increments `reopenCount`; opening balances default unverified; verify requires note; historical balance requires `source`.
   - Write `docs/M3_VERIFICATION.md` with step-by-step verification (CoA seed, FY periods, TZS 3.9M unverified entry, locked-period rejection, reopen flow).