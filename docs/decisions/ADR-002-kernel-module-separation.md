# ADR-002: Kernel/Module Separation

## Status
Accepted

## Date
2026-10-13

## Context
The PDF requirements (§17.17, §74) mandate that "future modules plug into the accounting core without rebuild" and that the system "should never become a collection of disconnected pages." With 9 platform substrates (Users, Permissions, Organizations, Projects, Documents, Notifications, Audit trail, APIs, Reporting, Financial data) that must be shared across all modules, we need a strict architectural boundary that prevents the accounting core from becoming coupled to any specific module.

## Decision
We enforce a **strict one-way dependency rule**:

```
┌────────────────────────────────────────────────────────────┐
│  PRESENTATION      app/** route segments, layouts, views   │
└──────────────────────────┬─────────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────────┐
│  MODULE LAYER        modules/<module>/                      │
│  server actions · queries · zod schemas · service wrappers │
│  MAY import from kernel.  NEVER imported BY the kernel.     │
│  NEVER imports another module's internals.                   │
└──────────────────────────┬─────────────────────────────────┘
                           │  one direction only
┌──────────────────────────▼─────────────────────────────────┐
│  ACCOUNTING & PLATFORM KERNEL        lib/                  │
│    accounting  posting, balance, GL, trial balance        │
│    periods     open / close / lock / reopen               │
│    approvals   generic workflow engine                    │
│    rbac        server-side authorization                   │
│    audit       append-only tamper-evident log             │
│    documents   pluggable storage abstraction              │
│    fx          currency + historical rates                │
│    dimensions  project / dept / cost centre / location    │
│    notifications · tax · money · workflow · import · search│
└──────────────────────────┬─────────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────────┐
│  INFRASTRUCTURE    prisma · storage · email · queue ·       │
│                    cache · rate-limit · structured logging   │
└────────────────────────────────────────────────────────────┘
```

### Enforcement Mechanisms
1. **ESLint `no-restricted-imports`**: `lib/**` cannot import from `modules/**` or `app/**`
2. **Import graph test**: Unit test asserts no upward edges (kernel → module)
3. **Kernel surface**: `lib/kernel/index.ts` is the only sanctioned export modules may import
4. **Module registry**: Each module declares `MODULE_KEY` and registers routes centrally

### Cross-Module Interaction
Modules interact **only through the kernel**:
- Invoicing calls `lib/approvals.request()` — never imports reconciliation code
- Reconciliation calls `lib/accounting.postJournalEntry()` — never imports invoicing types
- All modules use `lib/dimensions` for project/dept/cost-centre lookups

## Consequences

### Positive
- **Accounting core stays reusable**: Posting engine callable by any future module (Procurement, Inventory, Assets, Payroll)
- **No circular dependencies**: Architecture prevents the "ball of mud" anti-pattern
- **Clear ownership**: Module teams own their directory; kernel team owns `lib/`
- **Testability**: Kernel can be unit tested in isolation; modules tested with kernel mocks
- **Parallel development**: Multiple modules can be developed simultaneously without conflicts

### Negative
- **Initial overhead**: More directory structure, import discipline required
- **Duplication temptation**: Modules may want to copy kernel logic instead of using it (prevented by linting)
- **Refactoring friction**: Moving code from module to kernel (or vice versa) requires import updates

### Risks & Mitigations
| Risk | Mitigation |
|------|------------|
| Module imports another module's types | ESLint rule + code review; shared types in `lib/kernel/types.ts` |
| Kernel grows too large ("god object") | Split into focused sub-kernels (`lib/accounting`, `lib/approvals`, etc.) with `lib/kernel/index.ts` as facade |
| Presentation layer imports kernel directly | Allowed for reads (queries); mutations must go through Server Actions in modules |
| Emergency hotfix bypasses architecture | Documented exception process with tech lead approval + follow-up ticket |

## Implementation Details

### Kernel Public Surface (`lib/kernel/index.ts`)
```typescript
// Only these exports are sanctioned for module consumption
export { authorize, requireContext } from './authorize';
export { postJournalEntry, reverseJournalEntry, getTrialBalance } from './accounting';
export { requestApproval, decideApprovalStep } from './approvals';
export { writeAuditEntry, AuditAction, AuditEntityType } from './audit';
export { documentStorage, DocumentStorageProvider } from './documents';
export { loadEffectivePermissions, checkPermission } from './rbac';
// ... etc
```

### Module Structure
```
modules/
├── transactions/
│   ├── actions.ts          # Server Actions (mutations)
│   ├── queries.ts          # Server Components queries
│   ├── schemas.ts          # Zod validation
│   ├── services.ts         # Business logic (calls kernel)
│   └── index.ts            # Public exports (if any)
├── approvals/
├── reconciliation/
├── budgets/
└── invoices/
```

## Related Decisions
- ADR-001: Next.js App Router (presentation layer structure)
- ADR-003: Append-Only Audit Trail (kernel audit service)

## References
- PHASE_1_PLAN.md §2.2, §2.5
- BLECA_SMARTLABS_financial_website_requirements.pdf §17.17, §74