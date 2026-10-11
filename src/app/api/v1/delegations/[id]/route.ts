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

const updateDelegationSchema = z.object({
  scope: z.custom<Prisma.InputJsonValue | null>().optional(),
  reason: z.string().optional(),
  expiresAt: z.string().datetime().optional(),
  revokedAt: z.string().datetime().optional(),
  revocationReason: z.string().optional(),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ organizationId: string; id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'APPROVALS', action: 'VIEW' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const { id } = await params;

    const delegation = await prisma.delegation.findFirst({
      where: {
        id,
        OR: [
          { grantor: { organizationMemberships: { some: { organizationId: ctx.actor.organizationId } } } },
          { grantee: { organizationMemberships: { some: { organizationId: ctx.actor.organizationId } } } },
        ],
      },
      include: {
        grantor: { select: { id: true, email: true, fullName: true } },
        grantee: { select: { id: true, email: true, fullName: true } },
        role: { select: { id: true, code: true, name: true } },
      },
    });

    if (!delegation) {
      return apiError(new NotFoundError('Delegation', id), reqId);
    }

    return ok(delegation, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ organizationId: string; id: string }> },
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

    const { id } = await params;
    const orgId = ctx.actor.organizationId!;

    const existingDelegation = await prisma.delegation.findFirst({
      where: {
        id,
        OR: [
          { grantor: { organizationMemberships: { some: { organizationId: orgId } } } },
          { grantee: { organizationMemberships: { some: { organizationId: orgId } } } },
        ],
      },
    });

    if (!existingDelegation) {
      return apiError(new NotFoundError('Delegation', id), reqId);
    }

    if (existingDelegation.grantorId !== ctx.actor.userId && !ctx.actor.roleCodes.includes('CEO')) {
      return apiError(new ValidationError('Only the grantor or CEO can update this delegation'), reqId);
    }

    const body = updateDelegationSchema.parse(await request.json());

    const updateData: Record<string, unknown> = {};
    if (body.scope !== undefined) updateData.scope = body.scope ?? Prisma.JsonNull;
    if (body.reason !== undefined) updateData.reason = body.reason;
    if (body.expiresAt !== undefined) {
      const expiresAt = new Date(body.expiresAt);
      if (expiresAt <= new Date()) {
        return apiError(new ValidationError('expiresAt must be in the future'), reqId);
      }
      updateData.expiresAt = expiresAt;
    }
    if (body.revokedAt !== undefined) {
      updateData.revokedAt = new Date(body.revokedAt);
      updateData.revokedById = ctx.actor.userId;
      updateData.revocationReason = body.revocationReason;
    }

    const outcome = await runIdempotent({
      key,
      scope: `PUT /api/v1/delegations/${id}`,
      actorId: ctx.actor.userId,
      body: await request.json(),
      handler: async (tx) => {
        const delegation = await tx.delegation.update({
          where: { id },
          data: updateData,
          include: {
            grantor: { select: { id: true, email: true, fullName: true } },
            grantee: { select: { id: true, email: true, fullName: true } },
            role: { select: { id: true, code: true, name: true } },
          },
        });

        await writeAuditEntry(tx, { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, {
          action: body.revokedAt ? 'DELEGATION_REVOKED' : 'DELEGATION_GRANTED',
          entityType: 'DELEGATION',
          entityId: delegation.id,
          entityLabel: `${delegation.grantor?.fullName ?? existingDelegation.grantorId} -> ${delegation.grantee?.fullName ?? existingDelegation.granteeId}`,
          description: body.revokedAt ? `Delegation revoked` : `Delegation updated`,
          changes: body.revokedAt
            ? { revokedAt: { from: null, to: body.revokedAt ?? null }, revokedById: { from: null, to: ctx.actor.userId } }
            : { scope: { from: (existingDelegation.scope as Prisma.InputJsonValue | null) ?? null, to: (body.scope as Prisma.InputJsonValue | null) ?? null }, expiresAt: { from: existingDelegation.expiresAt.toISOString(), to: body.expiresAt ?? existingDelegation.expiresAt.toISOString() } },
          metadata: { revocationReason: body.revocationReason ?? null },
          result: 'SUCCESS',
          channel: 'WEB',
        }, { organizationId: orgId, requestId: reqId });

        return { status: 200, body: delegation };
      },
    });

    if (outcome.kind === 'REPLAYED') {
      return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    }

    return ok(outcome.result, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ organizationId: string; id: string }> },
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

    const { id } = await params;
    const orgId = ctx.actor.organizationId!;

    const existingDelegation = await prisma.delegation.findFirst({
      where: {
        id,
        OR: [
          { grantor: { organizationMemberships: { some: { organizationId: orgId } } } },
          { grantee: { organizationMemberships: { some: { organizationId: orgId } } } },
        ],
      },
    });

    if (!existingDelegation) {
      return apiError(new NotFoundError('Delegation', id), reqId);
    }

    if (existingDelegation.grantorId !== ctx.actor.userId && !ctx.actor.roleCodes.includes('CEO')) {
      return apiError(new ValidationError('Only the grantor or CEO can delete this delegation'), reqId);
    }

    const outcome = await runIdempotent({
      key,
      scope: `DELETE /api/v1/delegations/${id}`,
      actorId: ctx.actor.userId,
      body: {},
      handler: async (tx) => {
        await tx.delegation.delete({ where: { id } });

        await writeAuditEntry(tx, { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, {
          action: 'DELEGATION_REVOKED',
          entityType: 'DELEGATION',
          entityId: id,
          entityLabel: `${existingDelegation.grantorId} -> ${existingDelegation.granteeId}`,
          description: `Delegation deleted`,
          result: 'SUCCESS',
          channel: 'WEB',
        }, { organizationId: orgId, requestId: reqId });

        return { status: 204, body: null };
      },
    });

    if (outcome.kind === 'REPLAYED') {
      return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    }

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiError(error, reqId);
  }
}