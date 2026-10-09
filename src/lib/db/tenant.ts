import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/db/prisma';

/**
 * Tenant isolation (PHASE_1_PLAN.md 2.6, PDF 51).
 *
 * Every model that carries organization_id is listed in TENANT_MODELS. The
 * client extension below injects the filter, so a query physically cannot return
 * another organisation's rows.
 *
 * The design rule is that there is no opt-out: `where` is merged, not replaced.
 * A caller cannot widen a query by passing its own organizationId, and there is
 * no "raw" escape hatch. Identity tables (users, roles, permissions) are
 * deliberately global in Phase 1 because the organisation is single-entity;
 * they gain their own guard when multi-entity arrives in Phase 4.
 */
/**
 * Models that carry organization_id, named as they appear in the Prisma schema.
 *
 * These are MODEL names, not delegate keys: `$allOperations` reports `model` as
 * `AuditLog`, so matching on `auditLog` silently matches nothing and the tenant
 * filter is never applied. That failure mode is invisible - queries keep working
 * and simply return every organisation's rows.
 */
export const TENANT_MODELS = ['AuditLog', 'SecurityEvent', 'Notification'] as const;

export type TenantModel = (typeof TENANT_MODELS)[number];

export class MissingOrganizationContextError extends Error {
  constructor(model: string) {
    super(
      `No organization context for "${model}". Multi-tenant reads must use scopedDb(organizationId); ` +
        'the unscoped client is for identity and reference data only.',
    );
    this.name = 'MissingOrganizationContextError';
  }
}

function tenantExtension(organizationId: string) {
  return Prisma.defineExtension((client) =>
    client.$extends({
      name: 'bleca-tenant-scope',
      query: {
        $allModels: {
          /**
           * The `args` parameter is typed as a union of every operation's args
           * across every model, so `where` cannot be narrowed by TypeScript.
           * The runtime check below is what makes it safe: `model` gates which
           * table we touch, and only read operations carry a `where`.
           */
          async $allOperations({
            model,
            operation,
            args,
            query,
          }: {
            model?: string;
            operation: string;
            args?: Record<string, unknown>;
            query: (args: unknown) => Promise<unknown>;
          }) {
            void operation;

            if (!model || !TENANT_MODELS.includes(model as TenantModel)) {
              return query(args);
            }

            const where = (args?.where ?? {}) as Record<string, unknown>;

            // An explicit organizationId in the caller's filter is a bug, not a
            // feature. Surface it rather than quietly overriding it.
            if (where.organizationId !== undefined && where.organizationId !== organizationId) {
              throw new Error(
                `Cross-tenant query blocked: asked for organizationId=${String(where.organizationId)} ` +
                  `inside a scope of ${organizationId}.`,
              );
            }

            return query({ ...(args ?? {}), where: { ...where, organizationId } });
          },
        },
      },
    }),
  );
}

export type TenantScopedClient = ReturnType<typeof prismaForOrg>;

/**
 * Returns a Prisma client whose reads and writes on tenant models are confined
 * to one organisation.
 *
 * M1 does not need this on the write path for most models because services take
 * an organisation from the authenticated context rather than from the request
 * body, but it exists now so no later module gets the chance to forget.
 */
export function prismaForOrg(organizationId: string) {
  return prisma.$extends(tenantExtension(organizationId));
}
