# Data Protection & Privacy

## Disclaimer

> **IMPORTANT**: This document describes the technical controls implemented in the BLECA SmartLabs Finance system. It **flags for legal review**; the system records controls, it does not assert legal compliance. Legal compliance must be validated by qualified legal counsel for the applicable jurisdictions.

---

## 1. Data Classification

All data in the system is classified at the organization and record level:

| Classification | Description | Examples | Handling |
|----------------|-------------|----------|----------|
| `PUBLIC` | Safe for public disclosure | Published reports, marketing materials | No special controls |
| `INTERNAL` | Internal business data | Most financial records, operational data | Standard access controls |
| `CONFIDENTIAL` | Sensitive business data | Payroll, contracts, strategy docs | Enhanced logging, restricted export |
| `RESTRICTED` | Highly sensitive / regulated | PII, tax IDs, bank credentials, health data | Encryption at rest + in transit, audit all access, DLP |

**Default classification:** `INTERNAL` (set on Organization and User records)

---

## 2. Data Inventory

### Personal Data Categories
| Category | Tables | Legal Basis | Retention |
|----------|--------|-------------|-----------|
| User identity | `users`, `sessions`, `mfa_devices` | Contract, Legal obligation | 7 years post-deactivation |
| Contact info | `parties`, `contacts`, `party_addresses` | Contract, Legitimate interest | 7 years post-relationship |
| Financial identifiers | `transactions`, `invoices`, `payments`, `supplier_bank_details` | Legal obligation (tax), Contract | 10 years (Tanzania tax law) |
| Audit trail | `audit_logs`, `security_events` | Legal obligation, Legitimate interest | 7 years minimum |
| Authentication | `login_history`, `auth_policies` | Security, Legal obligation | 3 years |

### Special Category Data
- **Health data**: Not processed by this system
- **Biometric data**: MFA (TOTP only in Phase 1, WebAuthn reserved)
- **Criminal convictions**: Not processed

---

## 3. Retention Policies

### Configured via `RetentionPolicy` Model
Each `DocumentCategory` has a configurable retention policy:

```prisma
model RetentionPolicy {
  category        DocumentCategory
  retentionMonths Int
  action          RetentionAction  // ARCHIVE | DELETE | RETAIN_FOREVER
  legalBasis      String
  isActive        Boolean
}
```

### Default Retention (Tanzania Context)
| Category | Retention | Action | Legal Basis |
|----------|-----------|--------|-------------|
| `TAX_DOCUMENT` | 120 months (10 years) | ARCHIVE | Tanzania Tax Administration Act |
| `FINANCIAL_EVIDENCE` | 84 months (7 years) | ARCHIVE | Companies Act, Tax Law |
| `CONTRACT` | 84 months post-expiry | ARCHIVE | Contract law |
| `BANK_STATEMENT` | 84 months | ARCHIVE | Tax law, Audit |
| `RECEIPT` | 84 months | ARCHIVE | Tax law |
| `INVOICE` | 84 months | ARCHIVE | Tax law |
| `GRANT_DOCUMENT` | Per grant agreement | RETAIN_FOREVER | Grant terms |
| `COMPLIANCE_DOCUMENT` | 84 months | ARCHIVE | Regulatory |
| `OTHER` | 36 months | ARCHIVE | Business need |

**Legal Hold:** Overrides retention. Set via `LegalHold` model. Prevents deletion/archival.

---

## 4. Controlled Deletion

### Soft Delete Pattern
All business tables use soft delete (`deletedAt` timestamp):
- Records marked deleted, not removed
- Foreign keys preserved for referential integrity
- Queries automatically filter `deletedAt IS NULL`

### Hard Delete (Rare)
Only allowed for:
- `import_row` after import completes + retention
- `notification` after read + retention
- `session` after expiry + retention
- `idempotency_key` after expiry

**Process:**
1. Retention job identifies eligible records
2. Legal hold check (blocks if hold exists)
3. Audit log entry: `RETENTION_APPLIED`
4. Physical deletion in same transaction

### Right to Erasure (GDPR-style)
**Process:**
1. Request received → logged as `MasterDataChangeRequest`
2. Legal review → determine if legal obligation overrides
3. If approved:
   - Anonymize PII fields (name → "DELETED USER", email → hash)
   - Retain financial records (legal obligation)
   - Audit: `RETENTION_APPLIED` with `legalBasis`
4. If denied → requester notified with reasons

---

## 5. Breach Procedure

### Detection
- Automated: `SecurityEvent` types (`SUSPICIOUS_EXPORT_VOLUME`, `AUDIT_CHAIN_BROKEN`, `OFFLINE_QUEUE_REPLAY_ATTEMPT`)
- Manual: User report, audit finding

### Response (Per Incident Response Runbook)
1. **Contain** (0-15 min): Revoke sessions, block exports
2. **Assess** (15 min - 1 hr): Scope, data categories, subjects affected
3. **Notify** (per legal requirement):
   - Data subjects: "without undue delay" (max 72 hrs)
   - Regulator: 72 hours if risk to rights/freedoms
   - CEO: Immediate for CRITICAL
3. **Document**: Full timeline in incident tracker
4. **Remediate**: Root cause fix, control improvement

### Breach Record
Stored in `SecurityEvent` with:
- `type`: `DATA_BREACH` (new type if needed)
- `detail`: { categories, subjectCount, notificationSent, regulatorNotified }
- Linked to `audit_log` entry

---

## 6. Third-Party Access

### Subprocessors (Current)
| Provider | Purpose | Data Categories | Location | Safeguards |
|----------|---------|-----------------|----------|------------|
| Vercel | Hosting | All (processed) | EU/US | DPA, SCCs, SOC2 |
| Neon/Supabase | Database | All (stored) | EU | DPA, encryption at rest |
| AWS S3 (optional) | Document storage | Documents | EU/US | DPA, encryption, bucket policies |
| Email provider | Notifications | Email, name | Varies | DPA |

### Data Processing Agreements
- All subprocessors have signed DPAs
- SCCs in place for non-EU transfers
- Subprocessor list maintained and reviewed annually

### API Integrations (Future)
- Iventika, Uzanite (PDF §59)
- Banks, mobile money providers
- Each requires: DPA, security assessment, minimal data scope

---

## 7. Technical Controls

### Encryption
| State | Algorithm | Key Management |
|-------|-----------|----------------|
| At rest (DB) | PostgreSQL TDE / volume encryption | Cloud provider (Neon/Supabase) |
| At rest (Documents) | AES-256-GCM | Application-managed, key rotation |
| In transit | TLS 1.3 | Vercel/Cloud provider managed |
| In use (sensitive fields) | AES-256-GCM (application-level) | `account_number_enc`, `provider_config_enc`, `secret_enc` |

### Access Control
- RBAC with module/action/resource granularity
- Dimension-scoped grants (project, department, etc.)
- Temporary access with mandatory expiry
- Delegation with mandatory expiry
- Step-up auth for sensitive actions

### Audit & Monitoring
- Append-only audit log with hash chain
- Daily chain verification checkpoints
- Security events with severity + acknowledgment
- Anomaly detection (rule-based, no AI decisions)
- Export monitoring (volume, frequency)

### Data Minimization
- Only required fields collected
- PII not in logs (email normalized, not raw)
- Masking in UI for sensitive fields (bank account last 4)
- Purpose-limited API responses

---

## 8. Data Subject Rights

| Right | Implementation |
|-------|----------------|
| Access | `GET /api/v1/users/me`, `GET /api/v1/parties/{id}` |
| Rectification | `PATCH /api/v1/users/me`, `PATCH /api/v1/parties/{id}` |
| Erasure | `MasterDataChangeRequest` → legal review → anonymize |
| Restriction | `LegalHold` on specific records |
| Portability | `GET /api/v1/exports` (JSON/CSV) |
| Objection | Opt-out flags on `NotificationPreference` |
| Automated decisions | **Not used** - no profiling/automated decisions |

---

## 9. Cross-Border Transfers

**Current:** Vercel (US company, EU infrastructure), Neon (US, EU regions)
**Safeguards:**
- SCCs with all US providers
- EU region selection enforced
- No data processing in non-adequate countries without safeguards

---

## 10. Training & Awareness

- All engineers: Secure coding, data handling (onboarding + annual)
- Finance team: Data classification, retention, breach reporting
- CEO: Compliance oversight, breach notification authority

---

## 11. Audit & Compliance Evidence

**System-Generated:**
- `RetentionPolicy` records = policy evidence
- `LegalHold` records = hold evidence
- `AuditLog` entries = access/processing evidence
- `SecurityEvent` records = incident evidence
- `BackupRun` with `VERIFIED` status = availability evidence

**Manual:**
- DPA contracts with subprocessors
- Legal review opinions
- Training records
- Risk assessments (DPIA for high-risk processing)

---

## 12. Revision History

| Date | Version | Author | Changes |
|------|---------|--------|---------|
| 2026-10-13 | 1.0 | System | Initial version for M17 |

---

## Appendix: Legal Review Checklist

When engaging legal counsel, provide:
- [ ] This document
- [ ] Current `RetentionPolicy` records
- [ ] Subprocessor list with DPAs
- [ ] Data flow diagram
- [ ] Incident response plan
- [ ] Breach notification templates
- [ ] DPIA (if high-risk processing added)