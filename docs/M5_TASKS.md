# M5 Sub-Tasks: Transaction Lifecycle & Workflow State Machine

1. **Create workflow state machine kernel** (`lib/workflow/transaction-state-machine.ts`)
   - Implement `TransactionStateMachine` class with legal transitions: `DRAFT → SUBMITTED → APPROVED/REJECTED → POSTED/LOCKED → ADJUSTED/REVERSED`
   - Enforce only legal transitions; reject illegal ones with typed errors
   - Every transition attempt (legal or illegal) writes an audit entry via `lib/audit`
   - Unit tests: all legal transitions succeed; all illegal transitions rejected and audited

2. **Build transaction service & API routes** (`modules/transactions/`)
   - `lib/transactions/service.ts`: CRUD, submit, approve, reject, post, adjust, reverse, cancel
   - Posting creates exactly one balanced journal entry; updates budget actuals and account balances in single DB transaction
   - Idempotency key support on all mutating endpoints
   - API routes: `GET/POST /api/v1/transactions`, `GET/PATCH /api/v1/transactions/:id`, `POST /api/v1/transactions/:id/submit|approve|reject|post|adjust|reverse|cancel`
   - Validation: transaction without required evidence on document-required account rejected; dimensions persisted on transaction and generated journal lines

3. **Implement transaction list UI** (`app/transactions/page.tsx`)
   - Server-rendered list with filter (status, date range, project, department, amount), sort, search, export (CSV)
   - Pagination; links to detail, adjust, reverse screens
   - RBAC: only users with `TRANSACTIONS.VIEW` see the list; `TRANSACTIONS.CREATE` for new button

4. **Implement transaction detail & mutation screens**
   - `/transactions/[id]/page.tsx`: timeline (state transitions + audit), document links, journal entry preview
   - `/transactions/new/page.tsx`: form with all PDF §8 fields (id, date, description, account, amount, currency, project, department, cost centre, funding source, payment method, supporting document)
   - `/transactions/[id]/adjust/page.tsx` and `/reverse/page.tsx`: require reason code + evidence + link to original; only available in legal states

5. **Write integration & regression tests**
   - End-to-end lifecycle: create → submit → approve → post → adjust → reverse completes successfully
   - `APPROVED`/`POSTED` transactions cannot be edited or deleted (service layer + DB trigger verified)
   - Posting is idempotent under repeated request with same idempotency key
   - Reversal links to original and preserves visibility; illegal transitions rejected and visible in audit trail
   - Document "how to verify" note in `docs/M5_VERIFICATION.md`