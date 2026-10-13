import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { ValidationError } from '@/lib/kernel/errors';

const querySchema = z.object({
  severity: z.enum(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  type: z.string().optional(),
  acknowledged: z.coerce.boolean().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export async function GET(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'AUDIT_TRAIL', action: 'VIEW' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const { searchParams } = new URL(request.url);
    const query = querySchema.parse(Object.fromEntries(searchParams));

    const where: Record<string, any> = {
      organizationId: ctx.actor.organizationId,
    };

    if (query.severity) where.severity = query.severity;
    if (query.type) where.type = query.type;
    if (query.acknowledged !== undefined) {
      where.acknowledgedAt = query.acknowledged ? { not: null } : null;
    }

    const [events, total] = await Promise.all([
      prisma.securityEvent.findMany({
        where,
        orderBy: { occurredAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          id: true,
          type: true,
          severity: true,
          subjectType: true,
          subjectId: true,
          subjectLabel: true,
          description: true,
          detail: true,
          ipAddress: true,
          userAgent: true,
          requestId: true,
          acknowledgedAt: true,
          acknowledgedById: true,
          acknowledgementNote: true,
          resolvedAt: true,
          occurredAt: true,
        },
      }),
      prisma.securityEvent.count({ where }),
    ]);

    return ok(
      {
        data: events,
        pagination: {
          page: query.page,
          limit: query.limit,
          total,
          totalPages: Math.ceil(total / query.limit),
        },
      },
      200,
      reqId
    );
  } catch (error) {
    return apiError(error, reqId);
  }
}