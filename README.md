# BLECA SmartLabs Finance

A finance management and accounting system for BLECA SmartLabs. Phase 1, Milestone 1: authentication,
role-based access control, and a tamper-evident audit trail — the foundation every later module
depends on.

> **Milestone 1 only.** There is no ledger yet. The accounting core (chart of accounts, double-entry,
> trial balance) arrives in M3–M4. The dashboards say *not available* rather than showing zero,
> because a zero would be a false statement about the organisation's position.

---

## Quick start

```bash
npm install
cp .env.example .env.local       # then generate the three secrets; see below
docker compose up -d
npx prisma migrate deploy
npm run db:seed                  # needs SEED_CEO_EMAIL and SEED_CEO_PASSWORD
npm run dev                      # http://localhost:3000
```

Generate secrets — the app refuses to start with the placeholders:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

**Full walkthrough: [`docs/M1_VERIFICATION.md`](docs/M1_VERIFICATION.md)**

---

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | development server |
| `npm run build` | generate Prisma client + production build |
| `npm run gate` | lint → typecheck → test → build, in that order |
| `npm run lint` / `npm run typecheck` | static checks |
| `npm run test:unit` | fast, no database |
| `npm run test:integration` | real Postgres; **resets the test database** |
| `npm run test:e2e` | Playwright, against a real server |
| `npm run db:migrate` / `db:deploy` / `db:seed` / `db:studio` | database |
| `docker compose up -d` | Postgres, test Postgres, S3 mock, Mailpit |

---

## What exists today

- **Authentication** — argon2id passwords, TOTP MFA with replay protection, password reset, account
  lockout, per-account and per-IP rate limiting, session idle and absolute timeouts, device and
  session monitoring, immediate revocation.
- **RBAC** — permissions as data (module × action × resource), role grants, dimension scoping with
  DENY precedence, delegated authority with mandatory expiry, access reviews, step-up
  re-authentication for sensitive actions.
- **Audit trail** — append-only at the database level, hash-chained, HMAC-signed, verifiable on
  demand, with security events recorded against the record rather than a person.
- **API surface** — `/api/v1/users`, `/api/v1/users/[id]`, `/api/v1/audit`, `/api/v1/audit/verify`,
  with idempotency keys and one error mapping.
- **Dashboards** — CEO and Finance Officer, showing only what is actually known.

## What does not exist yet

Everything financial: chart of accounts, journal entries, trial balance, transactions, approvals,
budgets, treasury, reconciliation, invoices, documents, tax, reports, notifications, PWA, backups.
The module registry lists each as *planned* with its milestone, and the interface says so.

---

## Documentation

| Document | Contents |
|---|---|
| [`docs/M1_VERIFICATION.md`](docs/M1_VERIFICATION.md) | how to run it, and how to verify each claim |
| [`docs/architecture.md`](docs/architecture.md) | the one-way dependency rule, the kernel, the audit chain |
| [`docs/security.md`](docs/security.md) | controls implemented, and open items |
| [`../PHASE_1_PLAN.md`](../PHASE_1_PLAN.md) | the approved plan, with the CEO's answers to §9.1 |

---

## Two things to know before changing anything

**The dependency direction is one way.** `app/` → `modules/` → `lib/`. The kernel never imports a
module. This is what lets Phase 2 plug into the accounting core without rebuilding it, and it is
enforced by both an ESLint rule and a test that walks the real import graph.

**The audit trail has no write path beyond append.** Not "the UI hides it" — the database rejects
`UPDATE` and `DELETE` on `audit_logs`, and an inserted entry must chain from the current head. If you
find yourself wanting to correct an audit entry, the answer is to write a new one.