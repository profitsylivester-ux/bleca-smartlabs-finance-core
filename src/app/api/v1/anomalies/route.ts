import { NextRequest } from 'next/server';
import { z } from 'zod';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { withAudit } from '@/lib/db/with-audit';
import { writeAuditEntry } from '@/lib/audit/writer';
import { prisma } from '@/lib/db/prisma';
import { ValidationError } from '@/lib/kernel/errors';

const anomalyQuerySchema = z.object({
  status: z.enum(['OPEN', 'ACKNOWLEDGED', 'DISMISSED', 'CONFIRMED']).optional(),
  anomalyType: z.string().optional(),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  entityType: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

export async function GET(request: NextRequest) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'ANOMALY_DETECTION', action: 'VIEW' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const { searchParams } = new URL(request.url);
    const params = anomalyQuerySchema.parse(Object.fromEntries(searchParams));

    const where: Record<string, unknown> = { organizationId: ctx.actor.organizationId };
    if (params.status) where.status = params.status;
    if (params.anomalyType) where.anomalyType = params.anomalyType as never;
    if (params.severity) where.severity = params.severity;
    if (params.entityType) where.entityType = params.entityType as never;

    const [flags, total] = await Promise.all([
      prisma.anomalyFlag.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        select: {
          id: true,
          anomalyType: true,
          severity: true,
          status: true,
          entityType: true,
          entityId: true,
          entityLabel: true,
          description: true,
          evidence: true,
          dedupeKey: true,
          acknowledgedAt: true,
          acknowledgedById: true,
          dismissedAt: true,
          dismissedById: true,
          dismissReason: true,
          confirmedAt: true,
          confirmedById: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.anomalyFlag.count({ where }),
    ]);

    await withAudit(
      {
        organizationId: ctx.actor.organizationId,
        actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
        requestId: reqId,
      },
      async (tx) => {
        await writeAuditEntry(
          tx,
          { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
          {
            action: 'REPORT_GENERATED',
            entityType: 'ANOMALY_FLAG',
            entityId: 'list',
            description: `Listed anomaly flags (page ${params.page}, ${flags.length}/${total})`,
            metadata: {
              page: params.page,
              pageSize: params.pageSize,
              filters: { status: params.status, anomalyType: params.anomalyType, severity: params.severity, entityType: params.entityType },
            },
          },
          { organizationId: ctx.actor.organizationId, requestId: reqId },
        );
      },
    );

    return ok({ data: flags, page: params.page, pageSize: params.pageSize, total, totalPages: Math.ceil(total / params.pageSize) }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}