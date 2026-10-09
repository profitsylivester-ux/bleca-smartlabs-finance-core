import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/kernel/errors';

/**
 * /api/v1/audit
 *
 * Read-only by construction. There is no PUT, PATCH or DELETE handler here, and
 * the database would reject one if someone added it: audit_logs carries a
 * BEFORE UPDATE and BEFORE DELETE trigger that raise unconditionally.
 *
 * Denied attempts return 403 with an ACCESS_DENIED audit entry, which is the
 * negative-path behaviour PHASE_1_PLAN.md 5.4 requires.
 */

const querySchema = z.object({
  action: z.string().optional(),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  actor: z.string().optional(),
  result: z.enum(['SUCCESS', 'FAILURE', 'DENIED', 'PARTIAL']).optional(),
  channel: z.enum(['WEB', 'API', 'CLI', 'SYSTEM', 'SYNC']).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.coerce.number().int().min(1).optional(),
});

export async function GET(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, {
      module: 'AUDIT_TRAIL',
      action: 'VIEW',
      entity: { type: 'AUDIT_LOG' },
    });

    const url = new URL(request.url);
    const params = querySchema.parse(Object.fromEntries(url.searchParams.entries()));

    const where = {
      ...(params.action ? { action: params.action as never } : {}),
      ...(params.entityType ? { entityType: params.entityType as never } : {}),
      ...(params.entityId ? { entityId: params.entityId } : {}),
      ...(params.actor
        ? { actorName: { contains: params.actor, mode: 'insensitive' as const } }
        : {}),
      ...(params.result ? { result: params.result } : {}),
      ...(params.channel ? { channel: params.channel } : {}),
      ...(params.from || params.to
        ? {
            occurredAt: {
              ...(params.from ? { gte: new Date(params.from) } : {}),
              ...(params.to ? { lte: new Date(params.to) } : {}),
            },
          }
        : {}),
    };

    const [data, total, head] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { sequence: 'desc' },
        take: params.limit,
        ...(params.cursor ? { skip: params.cursor - 1 } : {}),
        select: {
          id: true,
          sequence: true,
          previousHash: true,
          entryHash: true,
          signature: true,
          actorId: true,
          actorName: true,
          actorRoleCodes: true,
          action: true,
          entityType: true,
          entityId: true,
          entityLabel: true,
          description: true,
          changes: true,
          metadata: true,
          ipAddress: true,
          userAgent: true,
          requestId: true,
          channel: true,
          result: true,
          errorMessage: true,
          occurredAt: true,
          recordedAt: true,
        },
      }),
      prisma.auditLog.count({ where }),
      prisma.auditChainHead.findUnique({
        where: { id: 1 },
        select: { sequence: true, entryHash: true },
      }),
    ]);

    const nextCursor =
      data.length === params.limit
        ? params.cursor
          ? params.cursor + data.length
          : data.length + 1
        : null;

    return ok(
      {
        data: data.map((entry) => ({ ...entry, sequence: entry.sequence.toString() })),
        pagination: { total, limit: params.limit, nextCursor },
        chainHead: head ? { sequence: head.sequence.toString(), entryHash: head.entryHash } : null,
      },
      200,
      reqId,
    );
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function POST() {
  const reqId = await requestId();
  return apiError(
    new ValidationError(
      'The audit trail is append-only. Entries are written by the services that perform the action, never supplied by a caller.',
    ),
    reqId,
  );
}

export async function PUT() {
  const reqId = await requestId();
  return apiError(new NotFoundError('No PUT handler exists on the audit trail by design'), reqId);
}

export async function DELETE() {
  const reqId = await requestId();
  return apiError(
    new NotFoundError('No DELETE handler exists on the audit trail by design'),
    reqId,
  );
}
