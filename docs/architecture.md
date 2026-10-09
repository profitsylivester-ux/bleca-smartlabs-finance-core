# Architecture

How BLECA SmartLabs Finance is put together, and why. Written for someone who has to make a change
safely six months from now.

---

## 1. The one rule everything else serves

```
presentation (app/)  →  modules/<module>/  →  lib/ (kernel)  →  infrastructure
                              ↓                    ↑
                              └──── never ─────────┘
```

Dependencies point one way. The kernel never imports a module or a page; a module never imports
another module's internals.

This exists because of one requirement: *"future modules plug into the accounting core without
rebuild"* (PDF §17.17, §74). If the posting engine ever imports an invoice type, it stops being
reusable, and Phase 2 would require rebuilding the core.

**It is enforced twice**, because one mechanism is always bypassable:

| Mechanism | File | Catches |
|---|---|---|
| ESLint import zones | `eslint.config.mjs` | direct and aliased imports, at lint time |
| Import-graph test | `src/tests/unit/import-graph.test.ts` | anything, including dynamic imports, by walking the real graph |

The graph test has already caught one real violation: the `audit-trail` module reaching into
`users-roles` to call its own chain-verification action.

---

## 2. Directory layout

```
prisma/
  schema.prisma              models, enums, indexes, relations
  migrations/                versioned; the *_audit_guards one is hand-written SQL
  seed.ts                    idempotent seed
  seed-data.ts               the permission and role catalogue (data, not code)
src/
  app/
    (auth)/                  login, mfa-verify, forgot/reset password
    (app)/                   authenticated shell + admin screens
    api/v1/                  external API surface
  lib/                       ===== KERNEL =====
    kernel/index.ts          the ONLY sanctioned kernel entry point
    kernel/authorize.ts      the single enforcement point
    kernel/context.ts        RequestContext, Dimensions
    kernel/errors.ts         typed errors
    db/                      prisma client, tenant extension, withAudit
    audit/                   hash chain, writer, verifier
    rbac/                    permission resolution, scope resolution
    auth/                    password, TOTP, sessions, policy, rate limit, Auth.js
    crypto/                  AES-GCM, canonical JSON, hashing
    api/                     idempotency, response mapping
  modules/
    module-registry.ts       one source of truth for navigation and gating
    auth/ users-roles/ audit-trail/
  components/                shared UI only
  tests/
    unit/ integration/ setup/
e2e/specs/                   Playwright
docs/
```

---

## 3. The kernel

`src/lib/kernel/index.ts` is the sanctioned surface. Modules import from `@/lib/kernel`, not from
`@/lib/accounting/posting` or any other deep path. The indirection is what makes the dependency rule
auditable.

### 3.1 `authorize()` — the enforcement point

Called as the **first statement** of every service function. It **throws**, never returns a boolean,
because a boolean can be ignored by a caller who forgets to check it.

It checks three things in order:

1. **Permission** — `(module, action, resource)` against the actor's live grants.
2. **Scope** — dimension grants, if the entity carries dimensions. DENY always wins.
3. **Step-up** — re-authentication for sensitive actions.

A denial is audited in its own committed transaction, so the record of the attempt survives even
though the request was refused.

### 3.2 `RequestContext`

Service functions take an explicit context rather than reading a module-level "current user". That is
what stops the API path from becoming a way around a check: Server Actions and route handlers both
go through the same kernel call.

### 3.3 `withAudit()`

Wraps every mutating service function. The audit write happens in the **same database transaction**
as the business mutation, so an audit failure rolls the mutation back. An unaudited mutation is
unreachable, not merely discouraged.

---

## 4. The audit chain

The guarantee is tamper-**evidence**, layered so that each layer catches what the one above cannot.

```
┌─ application ─────────────────────────────────────────────────────┐
│ lib/audit/writer.ts exposes write() and read(). There is no        │
│ update() and no delete().                                          │
└────────────────────────────────────────────────────────────────────┘
┌─ database ────────────────────────────────────────────────────────┐
│ BEFORE UPDATE / DELETE / TRUNCATE on audit_logs → raise.           │
│ These hold even against direct SQL with a leaked credential.       │
└────────────────────────────────────────────────────────────────────┘
┌─ chain linkage ───────────────────────────────────────────────────┐
│ An inserted row must chain from the current head and carry the     │
│ next sequence. A forged or gap-filled row cannot be written at all.│
└────────────────────────────────────────────────────────────────────┘
┌─ hash chain ──────────────────────────────────────────────────────┐
│ entry_hash = sha256(previous_hash, sequence, actor, action,        │
│                     entity, description, changes, occurred_at)     │
│ signature  = HMAC-SHA256(entry_hash, period key)                   │
│ Recomputed and re-derived on demand, or nightly from the last seal.│
└────────────────────────────────────────────────────────────────────┘
```

### 4.1 Two deliberate deviations from PHASE_1_PLAN.md §3.8.5

**`description` is in the hash.** The plan lists eight fields; those describe *who did what to which
record*. The description is the human-readable statement of the same event, and leaving it mutable
would let someone rewrite an entry's narrative — "approved invoice" into "denied invoice" — without
breaking anything. Including it is a strengthening.

**`description` and the null/empty distinction are enforced by JSON array serialisation.** A joined
string collapses `null` and `''` to the same field. `JSON.stringify([...])` does not, so swapping a
null actor id for an empty one breaks the chain.

### 4.2 Concurrency

A single mutable row, `audit_chain_head`, is locked with `SELECT ... FOR UPDATE` before each append.
That serialises concurrent writers, which is what makes the chain gap-free: an aborted transaction
rolls back the audit row **and** the head update together, so a sequence number can never be
consumed by a lost write.

---

## 5. Authentication

Auth.js owns the cookie and the JWT. It does **not** own authorisation.

```
Password check (attemptLogin)          ONE implementation of credential checking
        ↓
Session row created, unsatisfied       mfa_satisfied_at = NULL if MFA is required
        ↓
Auth.js "session-exchange" provider    exchanges the open session for the cookie
        ↓
JWT carries only the session id
        ↓
Every request re-validates that row    revocation is immediate, not token-expiry
```

Two providers exist on purpose. Verifying through both `credentials` and `attemptLogin` would check
the password twice, double-count the failed-attempt counter, and open two session rows per login.

**Timeouts are absolute instants resolved at issue time.** A later policy change cannot silently
extend a session that was issued with a shorter one.

**The MFA challenge creates a real session that grants nothing.** Every guarded route requires
`mfa_satisfied_at`, so an abandoned challenge has no access.

### 5.1 Authentication reveals nothing

Unknown address, wrong password, deactivated account and locked account all surface as one message.
Otherwise the login form is an account enumeration oracle with a rate limit attached.

---

## 6. RBAC

`Permission { module, action, resource }` is the Cartesian product, created as **data**. Adding a
role is an insert, not a deploy.

**Actions are a closed enum.** Adding one requires a migration — deliberately, because an action
that appears by typo is an action nobody reviewed.

**Scope resolution:**

```
1. collect grants for the actor's live roles
2. partition ALLOW / DENY per dimension
3. DENY always wins, in every combination
4. a dimension with NO grants is unrestricted   ← this is how the CEO is unrestricted
5. a dimension WITH grants requires the value in ALLOW
6. a record with no value for a dimension is not constrained by it
```

Rule 6 matters: treating "no project" as "outside every project" would hide every unprojected
transaction from a scoped user.

**Expiry is evaluated on every request**, not only by the nightly cleanup job. A grant that expired an
hour ago is inert now.

---

## 7. Data conventions

- **snake_case columns** via `@map`/`@@map`. Prisma's camelCase default is fine until you write raw
  SQL — and from M1 onward every guarantee Prisma cannot express is raw SQL. Settled now, with no
  data, rather than after go-live.
- **`Decimal(20,6)`** for money. Never `Float`.
- **Soft delete everywhere.** Hard delete is allowed only for session, login telemetry, notification
  and idempotency rows, and only after retention expiry. A database trigger refuses to delete a
  *live* session.
- **`organization_id` on every business table**, with a Prisma client extension that injects the
  filter and rejects a cross-tenant `where`.
- **No Tanzanian tax value and no bank file format in code.** Everything is configuration.

---

## 8. Deliberate substitutions

| Planned | Shipped | Why |
|---|---|---|
| MinIO for local S3 | `adobe/s3mock` | MinIO removed its Docker Hub images; `minio/minio` now fails to pull. Application code only ever sees the S3 driver. |

Both are documented at the point of substitution. Neither changes application behaviour.

---

## 9. What arrives next

M2 (organisation dimensions, currency and FX), M3 (chart of accounts, periods, opening balances),
M4 (double-entry core, general ledger, trial balance). M5 and M6 bring the transaction lifecycle and
the approval engine that Q2 and Q3 already constrain.

The kernel was built for those. If a M3–M6 module needs something the kernel does not expose, the
kernel is what should change — not the rule.