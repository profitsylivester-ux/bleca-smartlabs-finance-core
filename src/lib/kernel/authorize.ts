import type { Prisma } from '@/generated/prisma/client';
import {
  checkPermission,
  loadEffectivePermissions,
  type EffectivePermissions,
} from '@/lib/rbac/permissions';
import {
  evaluateScope,
  loadLiveRoleIds,
  loadScopeGrants,
  applyScopeFilter,
  type ScopeGrant,
} from '@/lib/rbac/scope';
import { recordAuditEvent } from '@/lib/db/with-audit';
import { AuthorizationError, StepUpAuthRequired } from '@/lib/kernel/errors';
import type { AuthorizationRequest, RequestContext } from '@/lib/kernel/context';

/**
 * authorize() - the single enforcement point (PHASE_1_PLAN.md 5.4).
 *
 * Rules of this function:
 *   * It is the FIRST statement of every service function that reads or writes.
 *   * It THROWS. It never returns a boolean, because a boolean can be ignored.
 *   * A denial is itself audited, in its own committed transaction, so the
 *     record of the attempt survives even though the request was refused.
 *   * It is server-side. Hiding a button is a usability affordance; this is the
 *     control.
 */

export interface AuthorizeOptions {
  /** Skip step-up enforcement. Only for callers that perform it separately. */
  ignoreStepUp?: boolean;
  /** Pre-loaded permissions, to avoid a second query inside one request. */
  effective?: EffectivePermissions;
  /** Pre-loaded scope grants, to avoid a second query inside one request. */
  scopeGrants?: ScopeGrant[];
  /** Set false for internal system jobs that already carry an actor. */
  auditDenials?: boolean;
}

export interface AuthorizationOutcome {
  permissions: EffectivePermissions;
  scopeGrants: ScopeGrant[];
}

const auditCache = new WeakMap<RequestContext, Promise<AuthorizationOutcome>>();

/**
 * Loads permissions and scope grants once per request.
 *
 * WeakMap keyed on the context object: a context is created per request, so the
 * entry is collectable as soon as the request finishes. This keeps repeated
 * authorize() calls in one request to a single round trip without introducing a
 * cross-request cache that could serve a stale grant after revocation.
 */
export async function loadAuthorization(ctx: RequestContext): Promise<AuthorizationOutcome> {
  const cached = auditCache.get(ctx);
  if (cached) return cached;

  const promise = (async () => {
    const permissions = await loadEffectivePermissions(ctx.actor.userId);
    const roleIds = await loadLiveRoleIds(ctx.actor.userId);
    const scopeGrants = await loadScopeGrants(roleIds);
    return { permissions, scopeGrants };
  })();

  auditCache.set(ctx, promise);
  return promise;
}

export async function authorize(
  ctx: RequestContext,
  req: AuthorizationRequest,
  options: AuthorizeOptions = {},
): Promise<AuthorizationOutcome> {
  const { permissions, scopeGrants } =
    options.effective && options.scopeGrants
      ? { permissions: options.effective, scopeGrants: options.scopeGrants }
      : await loadAuthorization(ctx);

  const check = checkPermission(permissions, req.module, req.action, req.resource);

  if (!check.granted) {
    await deny(
      ctx,
      req,
      `${ctx.actor.userId} lacks ${req.action} on ${req.module}`,
      'NO_MATCHING_PERMISSION',
    );
  }

  // Dimension scope only applies when the entity actually carries dimensions.
  if (req.entity?.dimensions) {
    const decision = await evaluateScope({
      grants: scopeGrants,
      dimensions: req.entity.dimensions,
    });
    if (!decision.allowed) {
      await deny(
        ctx,
        req,
        `${ctx.actor.userId} is out of scope for ${req.entity.type} on dimension(s) ${decision.blockedBy.join(', ')}`,
        'SCOPE',
      );
    }
  }

  // Step-up authentication: re-prove identity for sensitive actions.
  if (check.requiresStepUpAuth && !options.ignoreStepUp) {
    assertStepUpSatisfied(ctx);
  }

  return { permissions, scopeGrants };
}

/**
 * Step-up is satisfied only by a recent re-authentication on THIS session.
 *
 * Deliberately strict: a recent login on a different device does not satisfy a
 * step-up on this one, because the point of step-up is to prove the human at the
 * keyboard right now, not that they logged in at some point today.
 */
export function assertStepUpSatisfied(ctx: RequestContext): void {
  const satisfiedAt = ctx.actor.stepUpSatisfiedAt;
  const expiresAt = ctx.actor.stepUpExpiresAt;

  if (!satisfiedAt || !expiresAt) {
    throw new StepUpAuthRequired(
      'This action requires re-authentication. Supply your password (and MFA code) to continue.',
    );
  }

  if (expiresAt.getTime() <= Date.now()) {
    throw new StepUpAuthRequired(
      'The re-authentication grant has expired. Please authenticate again.',
    );
  }
}

async function deny(
  ctx: RequestContext,
  req: AuthorizationRequest,
  message: string,
  kind: 'NO_MATCHING_PERMISSION' | 'SCOPE',
): Promise<never> {
  const details = {
    module: req.module,
    action: req.action,
    resource: req.resource ?? null,
    entityType: req.entity?.type ?? null,
    entityId: req.entity?.id ?? null,
  };

  await recordAuditEvent(
    {
      organizationId: ctx.actor.organizationId,
      actor: {
        id: ctx.actor.userId,
        name: ctx.actor.fullName,
        roleCodes: ctx.actor.roleCodes,
      },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
      sessionId: ctx.actor.sessionId,
    },
    {
      action: kind === 'SCOPE' ? 'SCOPE_VIOLATION' : 'ACCESS_DENIED',
      entityType: req.entity?.type ?? 'SYSTEM',
      entityId: req.entity?.id ?? null,
      entityLabel: req.entity?.label ?? null,
      description: `Access denied: ${message}`,
      metadata: details,
      result: 'DENIED',
      channel: ctx.channel,
      securityEvent: {
        type: kind === 'SCOPE' ? 'SCOPE_VIOLATION' : 'PERMISSION_DENIED_SPIKE',
        severity: 'MEDIUM',
        description: `Denied: ${req.action} on ${req.module} for ${ctx.actor.email}`,
        subjectType: req.entity?.type ?? 'SYSTEM',
        subjectId: req.entity?.id ?? null,
        detail: details,
      },
    },
  );

  throw new AuthorizationError(
    kind === 'SCOPE'
      ? 'You are not authorised for this record. It is outside your assigned scope.'
      : 'You do not have permission to perform this action.',
    details,
    kind === 'SCOPE' ? 'SCOPE_VIOLATION' : 'FORBIDDEN',
  );
}

/**
 * Convenience for list queries: returns the `where` fragment that confines a
 * query to what the actor may see. There is intentionally no unfiltered variant.
 */
export async function scopeWhereFor(
  ctx: RequestContext,
  module: AuthorizationRequest['module'],
  action: AuthorizationRequest['action'],
  fieldPrefix = '',
): Promise<Prisma.JsonObject> {
  const { scopeGrants } = await loadAuthorization(ctx);
  return applyScopeFilter(scopeGrants, module, action, fieldPrefix) as Prisma.JsonObject;
}
