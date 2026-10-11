# M6 Tasks — Approval Workflow Engine, Policies, Delegations, Access Reviews

Each sub-task fits in one short session and builds incrementally.

---

## Task 1: Database Schema & Seed Policies

**Scope:** Prisma schema additions for `approval_policies`, `approval_policy_steps`, `approval_requests`, `approval_step_instances`, `approval_decision_records`; migration; seed script with CEO-only policy (amount > 0) per Q2.

**Acceptance:**
- `npx prisma migrate dev` creates tables cleanly
- Seed creates one active `ApprovalPolicy` with steps: `APPROVAL` (CEO final), `SIGN_OFF` (CEO)
- `policySnapshot` JSON column present on `approval_requests`

---

## Task 2: Approval Engine Core (`lib/approvals`)

**Scope:** Service functions in `lib/approvals/`:
- `selectPolicy(entityType, amount, context)` — evaluates conditions, returns policy + snapshot
- `evaluateConditions(policySnapshot, context)` — table-driven condition checks (amount, over-budget, restricted funding, new counterparty, changed supplier bank, non-base currency, cross-project, manual flag)
- `resolveApprovers(step, request, delegationResolver)` — handles delegations, enforces SOD (no self-approval, no preparer-as-approver)
- `advanceRequest(requestId, decision, actor)` — idempotent, records `ApprovalDecisionRecord` with SOD evidence

**Acceptance:**
- Unit tests: policy selected by amount band; inapplicable steps dropped; condition matrix passes; SOD rejection on self-approval; delegation routes and snapshots; expired delegation inert; edited policy doesn't affect in-flight

---

## Task 3: API Routes

**Scope:** Route handlers under `app/api/v1/`:
- `approval-policies` — CRUD (admin only)
- `approvals` — `POST` (submit), `/:id/decide`, `/:id/cancel`
- `delegations` — CRUD with mandatory expiry
- `access-reviews` — CRUD + certify/revoke actions

**Acceptance:**
- All routes enforce authorization via `authorize()`
- Idempotency keys required on mutating endpoints
- Audit entries written in same transaction

---

## Task 4: UI Screens

**Scope:** App Router pages:
- `/approvals` — inbox with filters (status, entity, SLA), pagination
- `/approvals/[id]` — request detail, timeline, policy history, decision buttons
- `/approvals/policies` — policy list + editor (steps, conditions, ordering)
- `/admin/delegations` — grant/revoke/expire table
- `/admin/access-reviews` — create review, list items, certify/revoke workflow

**Acceptance:**
- Server Components for reads; Server Actions for mutations
- RBAC gates via `lib/rbac` on every page/action
- CEO dashboard shows SOD exception tile (from Q3)

---

## Task 5: Integration & E2E Tests

**Scope:**
- Integration: full submit → route → approve → post flow for Transaction, Invoice, Payment, Reversal
- E2E: Finance Officer submits, cannot self-approve; CEO approves, posts; delegation tested; policy edit mid-flight doesn't affect in-flight; access review certifies/revokes roles
- Regression: double-decision rejected; every decision audited with SOD evidence

**Acceptance:**
- All M6 tests pass (`npm test -- approval`)
- Definition of Done from plan satisfied: transaction submitted by Finance Officer routes to CEO, cannot be self-approved; delegation works and expires; edited policy leaves in-flight unchanged; every decision individually auditable