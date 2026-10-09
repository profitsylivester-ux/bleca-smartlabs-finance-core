# Milestone 1 — How to run and how to verify

**Status:** complete. Gate green: `npm run lint && npm run typecheck && npm test && npm run build`.
**Scope:** foundation, authentication, base RBAC, organisation root, audit trail. No accounting
modules yet — see "What is deliberately absent" below.

---

## 1. Prerequisites

| Tool | Version | Check |
|---|---|---|
| Node.js | 22 or newer | `node --version` |
| Docker Desktop | any current | `docker version` |
| npm | 10 or newer | `npm --version` |

---

## 2. First run

```bash
npm install
cp .env.example .env.local        # then edit it (see below)
docker compose up -d              # Postgres, test Postgres, S3, Mailpit
npx prisma migrate deploy         # create the schema
npm run db:seed                   # permissions, roles, organisation, CEO account
npm run dev                       # http://localhost:3000
```

### Secrets you must generate

`.env.example` ships **placeholders**, and the application refuses to start while any of them are
still placeholders. Generate real values:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # x3
```

- `AUTH_SECRET` — Auth.js cookie encryption
- `ENCRYPTION_KEY` — AES-256-GCM for TOTP seeds and other secrets at rest
- `AUDIT_HMAC_KEY` — signs audit entries

Also set:

```
SEED_CEO_EMAIL=you@example.com
SEED_CEO_PASSWORD=<something you have not used elsewhere>
```

The seed **refuses to invent a CEO password**. If these are unset it creates the roles and the
organisation but no user, and says so.

### Local services

| Service | Port | Purpose |
|---|---|---|
| Postgres | 5432 | development database |
| Postgres (test) | 5433 | integration tests — safe to destroy |
| S3 mock | 4566 | object storage; documents arrive in M12 |
| Mailpit | 1025 / 8025 | SMTP sink; the inbox is at http://localhost:8025 |

---

## 3. First sign-in

1. Go to <http://localhost:3000/login> and sign in with `SEED_CEO_EMAIL` / `SEED_CEO_PASSWORD`.
2. You are **held at the MFA challenge**. That is correct, not a bug: the CEO role requires a
   second factor, and the seeded account has no enrolled device.
3. Enrol from **Settings → Security**, confirm with the code your authenticator app shows.
4. You are then asked to change the seeded password.

Both gates exist on purpose. An account that can complete sign-in without the second factor is the
control that failed, not the UX that is inconvenient.

---

## 4. What to check, in order

### 4.1 The gate

```bash
npm run lint
npm run typecheck
npm test              # unit + integration
npm run build
```

Expected: `158 passed`, no lint errors, no type errors, and a route table ending in
`ƒ /settings/security`.

### 4.2 A permission check that actually bites

The claim being tested: hiding a button is cosmetic; the server refuses.

1. Sign in as the CEO and open **Administration → Users & roles**. The CEO can create accounts.
2. From a terminal, with no session cookie at all:

```bash
curl -i http://localhost:3000/api/v1/audit
```

Expected: **`401`** with

```json
{"error":{"code":"UNAUTHENTICATED","message":"You are not signed in.","requestId":"..."}}
```

The `requestId` is there so a failed attempt can be found in the audit trail without guessing.

3. Try a protected page:

```bash
curl -i http://localhost:3000/dashboard/ceo
curl -i http://localhost:3000/admin/audit-trail
```

Expected: **`307`** redirecting to `/login`, and the rendered body is the sign-in page — never the
dashboard or the audit trail.

4. Sign in as a **read-only Auditor** (create one via the CEO interface first), then repeat the
   `POST /api/v1/users` call with that session's cookie. Expected: **`403`** with
   `{"error":{"code":"FORBIDDEN"}}`.
5. Open **Administration → Audit trail** and search for `ACCESS_DENIED`. The refusal was recorded.
   **This is the property that matters: a denied request leaves evidence.**

### 4.3 The audit trail cannot be edited

Write one entry first, if the database is empty — the trigger fires per row, so a statement matching
nothing simply affects nothing:

```bash
npx tsx scripts/audit-smoke.ts "manual verification"
```

That prints the chain head and the verification result. Then:

```bash
docker exec -it bleca-postgres psql -U bleca -d bleca_finance \
  -c "UPDATE audit_logs SET description = 'tampered' WHERE sequence = 1;"
docker exec -it bleca-postgres psql -U bleca -d bleca_finance \
  -c "DELETE FROM audit_logs WHERE sequence = 1;"
```

Expected, both times:

```
ERROR:  audit_logs is append-only (PDF 54): UPDATE is not permitted on audit_logs
ERROR:  audit_logs is append-only (PDF 54): DELETE is not permitted on audit_logs
```

A forged entry is refused too, because it does not chain from the head:

```bash
docker exec -it bleca-postgres psql -U bleca -d bleca_finance -c "INSERT INTO audit_logs
  (id,sequence,previous_hash,entry_hash,signature,action,entity_type,description,
   occurred_at,recorded_at,channel,result,actor_name,actor_role_codes,signature_key_version)
  VALUES ('forged',2,repeat('f',64),repeat('a',64),repeat('b',64),'SYSTEM','SYSTEM',
          'forged',now(),now(),'SYSTEM','SUCCESS','attacker','{}',1);"
```

Expected: `ERROR: audit chain link mismatch: entry 2 does not chain from the current head`.

The application has no update or delete path either. This is not a policy you can forget to apply —
it is a constraint the database enforces.

### 4.4 The chain verifies

```bash
npx tsx scripts/audit-smoke.ts "verify"
```

Expected: `chain status : VERIFIED across N entries`. Every entry hash is recomputed from its stored
fields and every signature re-derived from the HMAC key. The same check is behind the **Verify chain**
button in **Administration → Audit trail**.

You can also prove it detects tampering:

```bash
docker exec -it bleca-postgres psql -U bleca -d bleca_finance -c "ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_no_update;"
docker exec -it bleca-postgres psql -U bleca -d bleca_finance -c "UPDATE audit_logs SET description = 'edited after the fact' WHERE sequence = 1;"
docker exec -it bleca-postgres psql -U bleca -d bleca_finance -c "ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_no_update;"
npx tsx scripts/audit-smoke.ts "detect"
```

Expected: `chain status : BROKEN`, broken at sequence 1. This is exactly what
`src/tests/integration/audit-trail.test.ts` does, so you are reproducing an automated check.

> **Note:** once you do this, the development chain is permanently broken, because a broken chain is
> never repaired. Reset it with `npm run db:reset` when you are done.

### 4.5 The kernel stays a kernel

```bash
npm run test:unit -- src/tests/unit/import-graph.test.ts
```

This walks the real import graph and asserts `lib/` never imports `modules/` or `app/`, and that no
module imports another module's internals. It has already caught one real violation during
development.

---

## 5. Test suites

| Command | What it covers | Needs a database |
|---|---|---|
| `npm run test:unit` | pure domain logic: hashing, TOTP, scope resolution, rate limiting, the audit hash, the import graph | no |
| `npm run test:integration` | the guarantees Prisma cannot express | yes (resets `postgres-test`) |
| `npm run test:e2e` | the sign-in journey in a real browser | yes |

The integration suite **drops and recreates** the database named by `TEST_DATABASE_URL` on every
run. It refuses to start if that resolves to the same database as `DATABASE_URL`.

---

## 6. What is deliberately absent

This is Milestone 1. The following are **not** built, and the interface says so rather than showing
zero:

- No Chart of Accounts, journal entries, trial balance, or financial statements (M3–M4)
- No transactions, approvals, budgets, treasury, reconciliation, invoices, documents, tax (M5–M13)
- No reports, notifications, PWA, backups (M14–M17)

The module registry lists them as **planned** with their milestone. The navigation shows them under a
"planned" disclosure rather than linking to pages that do not exist.

Two specific things the dashboards deliberately refuse to do:

- Financial figures show **"Not available — M4"**, not `0`. A zero would be a false statement about
  BLECA's position.
- Nothing is presented as accurate unless it is. The `unverified / historical` flag that the
  ~TZS 3.9M bootcamp figure must carry arrives with the opening-balance model in M3.

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Invalid environment configuration` at boot | placeholder left in `.env.local` | generate real secrets (2.1) |
| `audit_chain_head is missing` | migrations not applied | `npx prisma migrate deploy` |
| `No AuthPolicy row exists` | seed not run | `npm run db:seed` |
| Integration tests fail on schema | test DB stale | `npm run test:integration` resets it automatically |
| Docker not found in this shell | PATH not refreshed | restart the terminal |
| Mailpit inbox empty | no mail module yet | expected until M16 |
| Login says "Incorrect email or password" for a correct password | account locked, or rate limited | wait 15 minutes; check the lockout policy in Settings → Security |

---

## 8. Where the answers to your Q1–Q12 live

| Q | Where it is implemented |
|---|---|
| Q1 in-app + email only | `NotificationChannel` keeps SMS/PUSH reserved; no delivery code for them |
| Q2 every amount needs CEO approval | `prisma/seed-data.ts` `CEO_APPROVAL_MODULES`; no amount band exists |
| Q3 CEO self-post waiver | arrives with the posting engine in M5; the `SodWaiver` model is specified, not built |
| Q4 lightweight project | `Project` model in `prisma/schema.prisma`, M2 |
| Q5 historical records | import pipeline in M8, migration in M17 |
| Q6 VAT + withholding, accountant TBD | tax engine M13; **no tax rate is hardcoded anywhere** |
| Q7 Finance Officer scoped to Mbeya | `RoleScopeGrant` + `evaluateScope`, asserted by tests |
| Q8 bank samples needed before M8 | M8 is gated on them |
| Q9 strict sequential numbering | M11 |
| Q10 offline allowlist | `SyncActionType` enum; enforcement in M17 |
| Q11 email provider unselected | `MAIL_PROVIDER` config; adapter not yet written |
| Q12 Supabase Postgres | `DATABASE_URL` only; no Postgres-specific SQL was needed |