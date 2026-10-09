/**
 * The kernel surface.
 *
 * PHASE_1_PLAN.md 2.2: this file is the ONLY sanctioned entry point into the
 * accounting and platform kernel. Modules import from '@/lib/kernel', never from
 * '@/lib/accounting/posting' or any other deep path. That indirection is what
 * makes the dependency direction enforceable (see eslint.config.mjs zones and
 * src/tests/unit/import-graph.test.ts) rather than merely documented.
 */

export { prisma } from '@/lib/db/prisma';
export { prismaForOrg, TENANT_MODELS, MissingOrganizationContextError } from '@/lib/db/tenant';
export type { Tx } from '@/lib/db/prisma';

export { withAudit, recordAuditEvent } from '@/lib/db/with-audit';
export type { AuditContext } from '@/lib/db/with-audit';

export {
  KernelError,
  AuthenticationError,
  AuthorizationError,
  StepUpAuthRequired,
  ValidationError,
  NotFoundError,
  ConflictError,
  RateLimitedError,
} from '@/lib/kernel/errors';
export type { KernelErrorCode } from '@/lib/kernel/errors';

export {
  authorize,
  loadAuthorization,
  assertStepUpSatisfied,
  scopeWhereFor,
} from '@/lib/kernel/authorize';
export type { AuthorizeOptions, AuthorizationOutcome } from '@/lib/kernel/authorize';

export { dimensionsOf, EMPTY_DIMENSIONS } from '@/lib/kernel/context';
export type {
  ActorContext,
  RequestContext,
  AuthorizationRequest,
  Dimensions,
} from '@/lib/kernel/context';

export { loadEffectivePermissions, checkPermission } from '@/lib/rbac/permissions';
export type {
  EffectivePermissions,
  PermissionCheck,
  ResolvedPermission,
} from '@/lib/rbac/permissions';

export {
  evaluateScope,
  applyScopeFilter,
  loadScopeGrants,
  loadLiveRoleIds,
  ALL_SCOPE_DIMENSIONS,
} from '@/lib/rbac/scope';
export type { ScopeGrant, ScopeDecision } from '@/lib/rbac/scope';

export { writeAuditEntry, writeSecurityEvent, SYSTEM_ACTOR } from '@/lib/audit/writer';
export { verifyChain, sealAndVerifyPeriod } from '@/lib/audit/verifier';
export type { ChainVerificationResult } from '@/lib/audit/verifier';
export type { AuditEntryInput, AuditActor, SecurityEventInput } from '@/lib/audit/types';

export { env } from '@/lib/env';
