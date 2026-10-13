# BLECA SmartLabs Finance

A finance management and accounting system for BLECA SmartLabs. Phase 1 complete (M1–M17):
double-entry core, controlled approvals, tamper-evident audit trail, PWA/offline, backups, DR,
security hardening, and documentation.

---

## Quick start

```bash
npm install
cp .env.example .env.local       # then generate secrets; see below
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

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string (Neon/Supabase/local) |
| `NEXTAUTH_SECRET` | Yes | 32+ byte base64 for JWT signing |
| `NEXTAUTH_URL` | Yes | Canonical URL (e.g., `https://app.bleca.finance`) |
| `AUTH_ENCRYPTION_KEY` | Yes | 32-byte base64 for encrypting MFA secrets, bank details |
| `AUTH_SIGNING_KEY` | Yes | 32-byte base64 for audit chain HMAC signing |
| `STORAGE_DRIVER` | No | `local` or `s3` (default: `local`) |
| `STORAGE_LOCAL_ROOT` | If local | Filesystem root for document storage (default: `./storage`) |
| `S3_ENDPOINT` | If S3 | S3-compatible endpoint (e.g., `https://s3.eu-central-1.amazonaws.com`) |
| `S3_BUCKET` | If S3 | Bucket name |
| `S3_REGION` | If S3 | Region (e.g., `eu-central-1`) |
| `S3_ACCESS_KEY_ID` | If S3 | Access key |
| `S3_SECRET_ACCESS_KEY` | If S3 | Secret key |
| `S3_FORCE_PATH_STYLE` | If S3 | `true` for MinIO/localstack |
| `EMAIL_SERVER_HOST` | Yes | SMTP host |
| `EMAIL_SERVER_PORT` | Yes | SMTP port (587) |
| `EMAIL_SERVER_USER` | Yes | SMTP username |
| `EMAIL_SERVER_PASSWORD` | Yes | SMTP password |
| `EMAIL_FROM` | Yes | From address (e.g., `BLECA Finance <finance@bleca.smartlabs>`) |
| `SEED_CEO_EMAIL` | For seed | CEO email for initial user creation |
| `SEED_CEO_PASSWORD` | For seed | CEO password (min 12 chars) |
| `NODE_ENV` | No | `development` \| `production` \| `test` |

---

## What exists today (Phase 1 Complete)

### Authentication & Identity
- **argon2id** passwords, **TOTP MFA** with replay protection, password reset, account lockout
- Per-account and per-IP rate limiting, session idle/absolute timeouts, device/session monitoring
- Immediate revocation on password/MFA change, admin revoke, suspected compromise

### RBAC (Permissions as Data)
- Module × action × resource permissions, role grants, dimension scoping (DENY precedence)
- Delegated authority with mandatory expiry, access reviews, step-up re-authentication

### Audit Trail (Append-Only, Tamper-Evident)
- Hash-chained, HMAC-signed, verifiable on demand
- Security events recorded against the **record**, not a person (PDF §65)

### Accounting Core (Double-Entry)
- Chart of Accounts (hierarchical, PDF §7 pre-reserved lines for future modules)
- Journal Entries / Lines — only writer of ledger balances
- Financial Periods (open/close/lock/reopen with CEO sign-off)
- Trial Balance, General Ledger reports

### Approvals (Generic Workflow Engine)
- Configurable policies per entity type, ordered steps, QUORUM/ANY/ALL resolution
- SOD enforcement (submitter ≠ approver), SOD waivers with CEO approval

### Treasury & Cash Management
- Treasury Accounts (cash, bank, mobile money, gateways, project/grant funds)
- Transfers (single balanced JE, cross-currency with FX difference)
- Payment Schedules, Statement Import, Reconciliation (auto-match + human confirm)

### Budgets & Commitments
- Multi-level (Company/Dept/Project/Funding/Activity), monthly phasing
- Commitments reserve budget (INVOICE, CONTRACT, PAYMENT_SCHEDULE, MANUAL)
- Revisions & Transfers (approval-gated, before/after snapshots)

### Parties & Commercial Documents
- Customers/Suppliers with credit holds, bank detail change approval (PDF §23)
- Quotations → Invoices → Payments → Receipts, Credit/Debit Notes
- Document management (versioned, OCR-ready, retention policies, legal holds)

### Tax & Compliance (Configurable, Not Hardcoded)
- Tax Rules (VAT, Withholding, Income, Turnover, Filing Fee, Stamp Duty)
- Obligations per period, payments linked to JE, credential tracking

### Import Pipeline (7-Stage Gated)
- Upload → Map Fields → Validate → Preview → Detect Duplicates → Approve → Import
- Provenance: original info, source, import date, verification status, migration history

### Financial Close
- Checklist per PDF §64 (11 items), CEO SIGN_OFF, reopen with audit trail

### Notifications & Anomaly Detection
- In-app + Email (SMS/Push architected for Phase 2)
- Rule-based anomaly flags (no AI decisions, no accused person — PDF §65)

### PWA / Offline (PDF §58)
- Manifest, Service Worker, Offline receipt capture (IndexedDB + sync queue)
- **Allowlist only**: RECEIPT_CAPTURE, DRAFT_SAVE, CONTACT_CARD_SAVE
- **Server-enforced refusal**: SUBMIT, APPROVE, REJECT, POST, REVERSE, PERIOD_CLOSE, PERIOD_REOPEN

### Backups & Disaster Recovery
- FULL / INCREMENTAL / POINT_IN_TIME backups to pluggable storage
- Verify (checksum + row counts), Restore Test (non-destructive comparison)
- Runbooks: backup-restore, incident-response, rollback, period-reopen, access-review

### Security Hardening
- TLS (Vercel), Encryption at rest (Postgres), MFA, RBAC, Secure sessions
- Rate limiting, Secure file uploads, Backup protection, Security monitoring
- Health check: `GET /api/v1/health` (uptime, DB, last backup)
- Security events dashboard: `/admin/security-events`

### Documentation
- Architecture, Schema, OpenAPI spec, 3 ADRs, Data protection (flags legal review)

---

## Documentation

| Document | Contents |
|---|---|
| [`docs/M1_VERIFICATION.md`](docs/M1_VERIFICATION.md) | how to run it, and how to verify each claim |
| [`docs/architecture.md`](docs/architecture.md) | the one-way dependency rule, the kernel, the audit chain |
| [`docs/schema.md`](docs/schema.md) | key entities and relationships |
| [`docs/api/openapi.yaml`](docs/api/openapi.yaml) | OpenAPI 3.0 specification |
| [`docs/decisions/ADR-001-use-nextjs-app-router.md`](docs/decisions/ADR-001-use-nextjs-app-router.md) |
| [`docs/decisions/ADR-002-kernel-module-separation.md`](docs/decisions/ADR-002-kernel-module-separation.md) |
| [`docs/decisions/ADR-003-append-only-audit-trail.md`](docs/decisions/ADR-003-append-only-audit-trail.md) |
| [`docs/data-protection.md`](docs/data-protection.md) | data classification, retention, breach procedure, **flags legal review** |
| [`docs/runbooks/backup-restore.md`](docs/runbooks/backup-restore.md) |
| [`docs/runbooks/incident-response.md`](docs/runbooks/incident-response.md) |
| [`docs/runbooks/rollback.md`](docs/runbooks/rollback.md) |
| [`docs/runbooks/period-reopen.md`](docs/runbooks/period-reopen.md) |
| [`docs/runbooks/access-review.md`](docs/runbooks/access-review.md) |
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