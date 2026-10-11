import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { runIdempotent } from '@/lib/api/idempotency';
import { writeAuditEntry } from '@/lib/audit/writer';
import { NotFoundError, ValidationError } from '@/lib/kernel/errors';
import { Prisma } from '@/generated/prisma/client';

const createDelegationSchema = z.object({
  granteeId: z.string(),
  kind: z.enum(['APPROVAL_AUTHORITY', 'TEMPORARY_ACCESS', 'ACTING_CAPACITY']),
  roleId: z.string().optional(),
  scope: z.custom<Prisma.InputJsonValue | null>().optional(),
  reason: z.string().min(1),
  startsAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ organizationId: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'APPROVALS', action: 'VIEW' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') || '20', 10)));
    const grantorId = searchParams.get('grantorId') || undefined;
    const granteeId = searchParams.get('granteeId') || undefined;
    const kind = searchParams.get('kind') || undefined;
    const activeOnly = searchParams.get('activeOnly') === 'true';

    const where: Record<string, unknown> = {
      OR: [
        { grantor: { organizationMemberships: { some: { organizationId: ctx.actor.organizationId } } } },
        { grantee: { organizationMemberships: { some: { organizationId: ctx.actor.organizationId } } } },
      ],
    };

    if (grantorId) where.grantorId = grantorId;
    if (granteeId) where.granteeId = granteeId;
    if (kind) where.kind = kind;
    if (activeOnly) {
      const now = new Date();
      where.revokedAt = null;
      where.startsAt = { lte: now };
      where.expiresAt = { gt: now };
    }

    const [delegations, total] = await Promise.all([
      prisma.delegation.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          grantor: { select: { id: true, email: true, fullName: true } },
          grantee: { select: { id: true, email: true, fullName: true } },
          role: { select: { id: true, code: true, name: true } },
        },
      }),
      prisma.delegation.count({ where }),
    ]);

    return ok({ data: delegations, total, page, pageSize }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ organizationId: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'APPROVALS', action: 'CONFIGURE' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const key = request.headers.get('idempotency-key');
    if (!key) {
      return apiError(new ValidationError('An Idempotency-Key header is required on this endpoint.'), reqId);
    }

    const orgId = ctx.actor.organizationId!;
    const body = createDelegationSchema.parse(await request.json());

    const grantee = await prisma.user.findFirst({
      where: { id: body.granteeId, organizationMemberships: { some: { organizationId: orgId } } },
    });

    if (!grantee) {
      return apiError(new ValidationError('Grantee not found in this organization'), reqId);
    }

    if (body.roleId) {
      const role = await prisma.role.findUnique({ where: { id: body.roleId } });
      if (!role) {
        return apiError(new ValidationError('Role not found'), reqId);
      }
    }

    const startsAt = new Date(body.startsAt);
    const expiresAt = new Date(body.expiresAt);

    if (expiresAt <= startsAt) {
      return apiError(new ValidationError('expiresAt must be after startsAt'), reqId);
    }

    if (expiresAt <= new Date()) {
      return apiError(new ValidationError('expiresAt must be in the future'), reqId);
    }

    const outcome = await runIdempotent({
      key,
      scope: `POST /api/v1/delegations`,
      actorId: ctx.actor.userId,
      body: await request.json(),
      handler: async (tx) => {
        const delegation = await tx.delegation.create({
          data: {
            grantorId: ctx.actor.userId,
            granteeId: body.granteeId,
            kind: body.kind,
            roleId: body.roleId,
scope: body.scope ?? Prisma.JsonNull,
            reason: body.reason,
            startsAt,
            expiresAt,
          },
          include: {
            grantor: { select: { id: true, email: true, fullName: true } },
            grantee: { select: { id: true, email: true, fullName: true } },
            role: { select: { id: true, code: true, name: true } },
          },
        });

        await writeAuditEntry(tx, { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, {
          action: 'DELEGATION_GRANTED',
          entityType: 'DELEGATION',
          entityId: delegation.id,
          entityLabel: `${delegation.grantor.fullName} -> ${delegation.grantee.fullName}`,
          description: `Delegation granted: ${body.kind} to ${grantee.fullName}`,
          metadata: { kind: body.kind, roleId: body.roleId ?? null, scope: body.scope ?? null, startsAt: startsAt.toISOString(), expiresAt: expiresAt.toISOString() },
          result: 'SUCCESS',
          channel: 'WEB',
        }, { organizationId: orgId, requestId: reqId });

        return { status: 201, body: delegation };
      },
    });

    if (outcome.kind === 'REPLAYED') {
      return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    }

    return ok(outcome.result, 201, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}