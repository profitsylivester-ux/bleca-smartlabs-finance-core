# Architecture Overview

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        PRESENTATION LAYER                       │
│  Next.js App Router (Server Components + Client Components)    │
│  ├── app/** — Route segments, layouts, pages                   │
│  ├── components/** — Shared UI components                      │
│  └── lib/** — Client-side utilities, hooks                     │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                        MODULE LAYER                             │
│  modules/<module>/ — Self-contained business modules           │
│  ├── server actions — Mutations (called by UI)                 │
│  ├── queries — Read operations (called by UI)                  │
│   ├── schemas — Zod validation schemas                         │
│  └── services — Business logic (called by actions/queries)     │
│                                                                 │
│  RULES:                                                         │
│  - MAY import from kernel (lib/)                                │
│  - NEVER imported BY kernel                                     │
│  - NEVER import another module's internals                     │
└──────────────────────────┬──────────────────────────────────────┘
                           │  One-way dependency
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                   ACCOUNTING & PLATFORM KERNEL                  │
│  lib/ — Shared platform services (single source of truth)      │
│                                                                 │
│  ├── accounting/   — Posting engine, balances, GL, trial bal   │
│  ├── periods/      — Open/close/lock/reopen                    │
│  ├── approvals/    — Generic workflow engine                   │
│  ├── rbac/         — Server-side authorization                 │
│  ├── audit/        — Append-only tamper-evident log            │
│  ├── documents/    — Pluggable storage abstraction             │
│  ├── fx/           — Currency + historical rates               │
│  ├── dimensions/   — Project/dept/cost centre/location         │
│  ├── notifications/— In-app + email delivery                   │
│  ├── tax/          — Configurable tax engine                   │
│  ├── money/        — Decimal arithmetic, formatting            │
│  ├── workflow/     — State machines, transitions               │
│  ├── import/       — 7-stage import pipeline                   │
│  ├── search/       — Full-text + faceted search                │
│  ├── backup/       — Backup, verify, restore-test              │
│  ├── sync/         — Offline queue, batch sync                 │
│  └── kernel/index.ts — Single sanctioned kernel surface        │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                      INFRASTRUCTURE LAYER                       │
│                                                                 │
│  ├── Prisma ORM + PostgreSQL (Neon/Supabase)                   │
│  ├── Storage: Local filesystem / S3-compatible                 │
│  ├── Email: Nodemailer (SMTP) / Resend                         │
│  ├── Queue: In-process (Phase 1) → Redis/Bull (Phase 2)        │
│  ├── Cache: Next.js cache + in-memory                          │
│  ├── Rate limiting: In-memory (Phase 1) → Redis (Phase 2)      │
│  ├── Structured logging: Pino → stdout (Vercel)                │
│  └── Auth: NextAuth.js (Auth.js) with custom adapter           │
└─────────────────────────────────────────────────────────────────┘
```

## Kernel / Module Separation

### The One-Way Rule
```
Modules → Kernel  ✓
Kernel  → Modules ✗
Modules → Modules ✗
```

### Enforcement Mechanisms
1. **ESLint `no-restricted-imports`**: `lib/**` cannot import from `modules/**` or `app/**`
2. **Import graph test**: Unit test asserts no upward edges
3. **Kernel surface**: `lib/kernel/index.ts` is the only sanctioned export
4. **Module registry**: Each module declares `MODULE_KEY` and registers routes

### Why This Matters
The accounting core (posting engine, period management, approvals) must be callable by **any future module**. When Phase 2 Procurement lands, it calls `lib/accounting` exactly like Invoicing does. If the posting engine ever imports an Invoice type, it stops being reusable and Phase 2 would require rebuilding the core — precisely what PDF §17.17 and §74 forbid.

## API-First Design

Every mutation is reachable through:
1. **Server Action** (for UI, co-located with component)
2. **Route Handler** `app/api/v1/**` (for external integrations)

Both call the same underlying service function which takes an explicit `RequestContext`:
```typescript
interface RequestContext {
  actor: { userId, fullName, roleCodes, organizationId, sessionId };
  permissions: ResolvedPermission[];
  requestId: string;
  idempotencyKey: string;
  ip: string;
  userAgent: string;
  channel: 'WEB' | 'API' | 'CLI' | 'SYSTEM' | 'SYNC';
}
```

This ensures authorization, audit, and idempotency **cannot be bypassed** by taking the internal path instead of the API.

## Ledger Invariants (Kernel-Level, Non-Negotiable)

1. **Decimal(20,6)** for money. Never Float.
2. **Per-currency + base-currency** amounts. Base = TZS.
3. **Journal entry postable only if ALL hold:**
   - Σ(debits) = Σ(credits) across lines
   - All lines share one currency (multi-currency → split + FX entry)
   - Period is `OPEN` or `REOPENED`
   - Posting user ≠ submitting user (segregation of duties)
   - Completed `ApprovalRequest` where policy requires
   - Every line's account is `POSTABLE` and `ACTIVE` or `LOCKED`-but-approved
4. **JournalEntry/JournalLine** are the **only** writer of ledger balances.
5. **Balances are derived** from `JournalLine` by query. `AccountBalanceSnapshot` is a rebuildable cache.
6. **Immutability**: DB triggers reject UPDATE/DELETE on posted/locked entries.

## PWA / Offline Architecture

```
┌─────────────────┐     Offline      ┌──────────────────┐
│   Browser       │ ◄──────────────► │  IndexedDB       │
│   (SW + App)    │   Queue writes   │  (offlineReceipts│
└────────┬────────┘                  │   syncQueue)     │
         │                           └────────┬─────────┘
         │ Online                          │
         ▼                                 ▼
┌─────────────────────────────────────────────────────┐
│                  Sync API                           │
│  POST /api/v1/sync/batch                            │
│  - Validates idempotency keys                       │
│  - Enforces offline allowlist (server-side)         │
│  - Returns per-item conflict descriptors            │
└─────────────────────────────────────────────────────┘
```

### Offline Allowlist (Client + Server Enforced)
| Action | Allowed Offline? |
|--------|-----------------|
| `RECEIPT_CAPTURE` | ✓ |
| `DRAFT_SAVE` | ✓ |
| `CONTACT_CARD_SAVE` | ✓ |
| `SUBMIT` | ✗ |
| `APPROVE` | ✗ |
| `REJECT` | ✗ |
| `POST` | ✗ |
| `REVERSE` | ✗ |
| `PERIOD_CLOSE` | ✗ |
| `PERIOD_REOPEN` | ✗ |

**Server returns distinct error code** `OFFLINE_ACTION_NOT_ALLOWED` for high-risk actions attempted without connectivity.

## Security Architecture

```
┌────────────────────────────────────────────────────────────┐
│                    DEFENSE IN DEPTH                        │
├────────────────────────────────────────────────────────────┤
│ Network: Vercel Edge (DDoS, WAF, TLS 1.3)                 │
│ Application: Next.js (CSP, HSTS, X-Frame-Options)         │
│ Authentication: NextAuth.js + Argon2id + TOTP MFA         │
│ Authorization: Kernel RBAC (every service function)        │
│ Session: Short-lived JWT + server-side revocation          │
│ Data: Encryption at rest (Postgres TDE + app-level)        │
│ Audit: Append-only hash chain + daily checkpoints          │
│ Rate Limiting: Auth routes (strict), Financial (moderate)  │
│ File Upload: Type validation, size limits, virus scan      │
│ Secrets: Vercel env vars, never in code                    │
│ Monitoring: Security events dashboard + alerting           │
└────────────────────────────────────────────────────────────┘
```

## Multi-Tenant Isolation

Every table carries `organizationId`. Prisma client extensions inject the filter:
```typescript
// lib/db/prisma.ts
export const prisma = new PrismaClient().$extends({
  query: {
    $allModels: {
      async $allOperations({ args, query }) {
        if (args.where) {
          args.where = { ...args.where, organizationId: getCurrentOrgId() };
        }
        return query(args);
      },
    },
  },
});
```

## Deployment Topology

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Vercel    │────►│  PostgreSQL │◄───►│   Storage   │
│  (App +     │     │  (Neon/     │     │  (Local/    │
│   API)      │     │   Supabase) │     │   S3)       │
└─────────────┘     └─────────────┘     └─────────────┘
       │
       ▼
┌─────────────┐
│  Email      │
│  (SMTP/     │
│   Resend)   │
└─────────────┘
```

- Single Next.js deployment on Vercel
- Database: Neon (serverless Postgres) or Supabase
- Storage: Local (dev) / S3-compatible (prod)
- Email: SMTP via Nodemailer or Resend API
- No separate worker processes in Phase 1 (in-process queue)

## Phase 2+ Extensibility Points

| Area | Current | Phase 2+ Extension |
|------|---------|-------------------|
| Modules | Kernel-only imports | New modules under `modules/` |
| Queue | In-process | Redis + BullMQ |
| Cache | Next.js cache | Redis Cluster |
| Rate Limit | In-memory | Redis sliding window |
| Notifications | In-app + Email | SMS, Push, Webhook |
| Auth | TOTP | WebAuthn, SSO (SAML/OIDC) |
| Storage | Local/S3 | Azure Blob, GCS |
| Multi-entity | Single entity flag | Full multi-entity hierarchy |