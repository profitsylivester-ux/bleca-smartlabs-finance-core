# Security

What is implemented in Milestone 1, what it does and does not guarantee, and what is still open.

This document records **controls**, not compliance. Nothing here asserts that the system satisfies
any legal requirement. Data-protection obligations under PDF §56 are flagged for legal review in
`docs/data-protection.md` and are not this document's claim to make.

---

## 1. Secrets

| Rule | Implementation |
|---|---|
| No secret in code or repository | ESLint rule `bleca/no-secrets-in-source`; `.env*` git-ignored; `.env.example` ships placeholders only |
| No placeholder in a running system | `lib/env.ts` refuses to start with a placeholder value |
| Secrets encrypted at rest | AES-256-GCM, `lib/crypto` |
| Passwords | Argon2id, parameters from `Argon2PasswordPolicy` in `auth_policies` |

**There is no default CEO password in the repository.** The seed refuses to create the account unless
`SEED_CEO_EMAIL` and `SEED_CEO_PASSWORD` are set, and the created account is forced to change it and
to enrol MFA.

### 1.1 Key rotation

| Key | Rotation story |
|---|---|
| `AUTH_SECRET` | rotating it invalidates all sessions — everyone signs in again. Acceptable and safe. |
| `ENCRYPTION_KEY` | **not yet rotatable.** Rotation would require re-encrypting every TOTP secret. Runbook is in M17. |
| `AUDIT_HMAC_KEY` | `audit_logs.signature_key_version` exists so rotation is additive, but only one key is configured today. |

---

## 2. Authentication

| Control | Where | Note |
|---|---|---|
| Strong passwords | `auth_policies` | min length, character classes, all configurable |
| Password-based email rejected | `looksLikeEmail` | "one of the first things anyone tries" |
| Argon2id | `lib/auth/password` | parameters are explicit, not library defaults |
| MFA (TOTP) | `lib/auth/totp` | required for CEO and Finance Officer by role |
| MFA replay protection | `mfa_devices.last_used_counter` | a code is accepted **once** |
| MFA secrets encrypted | AES-256-GCM | never returned by any endpoint, never logged, never in an audit `changes` payload |
| Account lockout | `auth_policies` | after N consecutive failures, for M minutes |
| Rate limiting | per-account **and** per-IP | separate buckets: one catches stuffing against one account, the other a spray across many |
| Password reset | single-use, 30-minute expiry | revokes every session on completion |
| Generic failure messages | `lib/auth/service` | unknown address and wrong password are indistinguishable |

### 2.1 Account enumeration

The reset endpoint reports success for every address, and records in the audit trail whether a token
was actually issued. Two E2E tests assert the wording is identical for a known and an unknown address.

---

## 3. Sessions

- **The `sessions` row is the authority, not the JWT.** The token carries only a session id.
- **Revocation is immediate.** An admin revoking a session takes effect on the target's next request,
  not when a token expires.
- **Both timeouts are absolute instants resolved at issue time.** A later policy change cannot
  silently extend a live session.
- **Idle timeout is a write on every request**, which is what makes it mean idle rather than "since
  someone last asked to extend it".
- Cookies are `httpOnly`, `sameSite=lax`, and `secure` in production.
- **A database trigger refuses to delete a live session**, so a bug cannot destroy evidence of an
  active session.

---

## 4. Authorization

- `authorize()` is the **server-side** enforcement point. The UI hides controls for usability; it is
  never the control.
- It **throws**. A permission check that returns a boolean can be ignored.
- **Denials are audited.** A refused request leaves an `ACCESS_DENIED` entry and a `SecurityEvent`.
- **Denying yourself is possible**, and that is intentional: a silent 403 with no trace is how a
  probing attack stays invisible.
- `AUTHORIZE` covers Server Actions and `/api/v1/**` equally, because both call the same kernel
  function.
- **Step-up re-authentication** is required for permission changes, period reopen, high-value exports
  and supplier bank details. The grant is consumed by one action.

### 4.1 Current limitation, stated plainly

The Finance Officer's Mbeya scope is **modelled and tested** (`RoleScopeGrant`, `evaluateScope`) but
**no Mbeya location record exists yet** — locations arrive in M2. Until then every role is effectively
unrestricted, because a scope grant for a non-existent value restricts nothing that exists.

This is recorded rather than hidden. It is the one place where a control is implemented and not yet
exercised by data.

---

## 5. Audit trail

| Property | Enforcement |
|---|---|
| Append-only | database trigger on UPDATE, DELETE and TRUNCATE |
| Chain-linked | insert must chain from the head and carry the next sequence |
| Tamper-evident | SHA-256 chain + HMAC signature per entry |
| Verifiable | on demand, or nightly from the last seal |
| Same-transaction | `withAudit()` — an audit failure rolls the mutation back |
| Access-controlled | `(AUDIT_TRAIL, VIEW)`; content redacted for non-admins |
| Queryable | filtered by actor, action, entity, result, channel, IP, date |
| Viewing is audited | PDF §49 export logging applies to the audit trail itself |

### 5.1 What the chain cannot do

**It cannot be repaired.** A broken chain is reported as `CRITICAL` and surfaced to the CEO. Silently
rewriting it would destroy exactly what the break is evidence of. Recovery is manual and is a
documented decision, not an automatic one.

### 5.2 Privilege defence in depth

`REVOKE UPDATE, DELETE ON audit_logs FROM bleca_app` is applied, and the migration creates that
least-privilege role.

**In local development the app connects as the table owner, so the REVOKE is inert there.** That is
why the integration suite asserts the **trigger** rather than the grants: the trigger is the control
that holds in every environment. Production must connect as `bleca_app` for the privilege layer to be
real. Making that switch is an M17 hardening item.

---

## 6. Encryption

| Data | Method |
|---|---|
| In transit | TLS only; secure cookies in production |
| TOTP secrets, reset tokens, treasury fields | AES-256-GCM (authenticated — tampering fails to decrypt) |
| Passwords | Argon2id |
| Audit entries | SHA-256 chain, HMAC-SHA256 signatures |
| At rest (database) | provider-managed; **encryption at rest for the database volume is a deployment setting and has not been verified for BLECA's production instance** |

---

## 7. AI boundaries

Not merely unused in M1 — **structurally prevented**:

- Anomaly models (M16) have no `accusedUserId`. The subject is the record, not a person (PDF §65).
- AI adapters are interfaces with no write access to financial state.
- A flag never blocks, rejects or holds money. A named human must acknowledge it first.
- Tests assert AI cannot approve, post, transfer or delete.

---

## 8. Open items

| # | Item | Blocks |
|---|---|---|
| S1 | Connect production as `bleca_app`, not the table owner | go-live |
| S2 | `ENCRYPTION_KEY` rotation procedure | M17 |
| S3 | Verify database volume encryption on the production instance | go-live |
| S4 | Data-protection obligations under PDF §56 — **legal review required** | go-live |
| S5 | Real Mbeya location rows so the Finance Officer scope is exercised | M2 |
| S6 | WAF / rate-limit layer in front of the deployment | go-live |
| S7 | Backup verification and an executed restore drill | M17 |
| S8 | Malware scanning hook for uploads | M12 |

S4 is flagged, not answered. **This document does not provide legal advice and makes no compliance
claim.**