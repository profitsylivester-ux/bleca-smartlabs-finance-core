# ADR-003: Append-Only Audit Trail

## Status
Accepted

## Date
2026-10-13

## Context
PDF §54 requires a tamper-evident audit trail. The system must provide cryptographic proof that:
1. No audit entry has been deleted or modified
2. The sequence of entries is complete (no gaps)
3. The chain can be verified independently of application code

This is a **regulatory and compliance requirement**, not just a feature. Financial auditors, tax authorities, and potential investors will verify the audit trail integrity.

## Decision
We implement an **append-only audit trail with hash chaining and HMAC sealing**, enforced at the **database level** via PostgreSQL triggers, not application convention.

### Data Model
```prisma
model AuditLog {
  id             String  @id @default(cuid())
  organizationId String?
  sequence       BigInt  @unique @default(autoincrement())  // Total ordering
  previousHash   String?                                   // SHA-256 of prior entry
  entryHash      String  @unique                           // SHA-256(this entry)
  signature      String                                    // HMAC-SHA256(entryHash, periodKey)
  signatureKeyVersion Int  @default(1)                      // Key rotation audit
  
  actorId        String?
  actorName      String?                                   // Denormalized (survives user deletion)
  actorRoleCodes String[] @default([])                     // Roles at action time
  
  action         AuditAction
  entityType     AuditEntityType
  entityId       String?
  entityLabel    String?
  description    String
  changes        Json?                                     // { field: { from, to } }
  metadata       Json?
  
  ipAddress      String?
  userAgent      String?
  requestId      String?
  sessionId      String?
  channel        AuditChannel @default(WEB)
  result         AuditResult  @default(SUCCESS)
  errorMessage   String?
  
  occurredAt     DateTime                                  // Client-supplied (offline sync)
  recordedAt     DateTime  @default(now())                 // Server write time
}

model AuditChainHead {
  id        Int      @id @default(1)                      // Single row
  sequence  BigInt   @default(0)                          // Latest sequence
  entryHash String   @default("")                         // Latest entry hash
  updatedAt DateTime @updatedAt
}

model AuditChainCheckpoint {
  id                    String                  @id @default(cuid())
  periodStart           DateTime
  periodEnd             DateTime
  sealedThroughSequence BigInt
  sealedEntryHash       String
  sealedAt              DateTime  @default(now())
  verifiedAt            DateTime?
  status                ChainVerificationStatus @default(PENDING)
  entriesChecked        Int       @default(0)
  brokenAtSequence      BigInt?
  detail                String?
}
```

### Hash Chain Algorithm
```
entryHash = SHA256(
  previousHash || 
  sequence || 
  actorId || 
  action || 
  entityType || 
  entityId || 
  JSON.stringify(changes) || 
  occurredAt.toISOString()
)

signature = HMAC_SHA256(entryHash, periodSigningKey)
```
- `previousHash` of first entry = empty string
- `sequence` from `AuditChainHead` (auto-increment, serialized by `SELECT FOR UPDATE`)

### Database-Level Enforcement (Critical)
**PostgreSQL triggers prevent any application bypass:**

```sql
-- 1. Prevent UPDATE/DELETE on audit_logs
CREATE TRIGGER audit_logs_immutable
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION reject_write();

-- 2. Serialize inserts via AuditChainHead row lock
CREATE FUNCTION audit_logs_insert_guard() RETURNS TRIGGER AS $$
BEGIN
  -- Lock the chain head row (serializes concurrent inserts)
  PERFORM pg_advisory_xact_lock(12345); -- or SELECT FOR UPDATE on audit_chain_head
  
  -- Verify previous_hash matches current head
  -- Compute entry_hash, signature
  -- Update audit_chain_head
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

### Daily Verification Checkpoints
- Nightly job reads from last checkpoint
- Recomputes hashes sequentially
- Stores `AuditChainCheckpoint` with `status: VERIFIED` or `BROKEN`
- `BROKEN` checkpoint → `SecurityEvent` type `AUDIT_CHAIN_BROKEN` (CRITICAL) → alerts CEO

### Key Rotation
- `signatureKeyVersion` on each entry
- Period signing keys derived from master key + period
- Rotation: new version, old entries still verifiable

### Offline Sync Considerations
- Client supplies `occurredAt` (may differ from `recordedAt`)
- Divergence between `occurredAt` and `recordedAt` is itself a signal
- Idempotency keys prevent duplicate audit entries on replay

## Consequences

### Positive
- **Tamper-evident by design**: Database triggers enforce immutability; even `psql` superuser cannot silently modify
- **Gap detection**: Auto-increment `sequence` + `previousHash` chain detects any deleted entry
- **Independent verification**: Auditor can verify chain with only database read access (no app code needed)
- **Legal defensibility**: Cryptographic proof meets regulatory standards
- **Performance**: Single-row `AuditChainHead` lock serializes writes without table locks

### Negative
- **Write serialization**: All audit writes contend on `AuditChainHead` row (mitigated: fast path, <1ms)
- **Storage growth**: Audit log grows unbounded (mitigated: partitioning by month, retention policies)
- **Key management**: Period signing keys must be backed up securely (HSM or Vercel encrypted env)
- **Complexity**: More moving parts than simple audit table

### Risks & Mitigations
| Risk | Mitigation |
|------|------------|
| Chain head lock becomes bottleneck | Batch audit writes in high-throughput paths; monitor `pg_locks` |
| Signing key compromised | Key rotation + `signatureKeyVersion`; old entries still verifiable |
| Trigger bypassed by `pg_dump`/`pg_restore` | Verification job runs after any restore; `BROKEN` = incident |
| Offline client submits backdated `occurredAt` | Server `recordedAt` is source of truth; divergence logged as metadata |

## Audit Action Taxonomy
Actions are **fine-grained** (not generic "UPDATE"):
- `TRANSACTION_POSTED`, `TRANSACTION_REVERSED`, `JOURNAL_ENTRY_POSTED`
- `PERIOD_CLOSED`, `PERIOD_REOPENED`, `BACKUP_VERIFIED`, `RESTORE_TEST`
- `USER_CREATED`, `ROLE_ASSIGNED`, `PERMISSION_GRANTED`
- `APPROVAL_REQUEST_APPROVED`, `APPROVAL_REQUEST_REJECTED`

This enables precise compliance queries: "Show all `PERIOD_REOPENED` actions in 2025."

## Related Decisions
- ADR-002: Kernel/Module Separation (audit in kernel, modules call `writeAuditEntry`)
- ADR-001: Next.js App Router (Server Actions ensure audit in same transaction)

## References
- PHASE_1_PLAN.md §3.8, §7
- BLECA_SMARTLABS_financial_website_requirements.pdf §54
- NIST SP 800-92 (Guide to Computer Security Log Management)