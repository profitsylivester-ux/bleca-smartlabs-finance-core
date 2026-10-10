import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { runIdempotent } from '@/lib/api/idempotency';
import { withAudit } from '@/lib/db/with-audit';
import { writeAuditEntry } from '@/lib/audit/writer';
import { NotFoundError, ValidationError } from '@/lib/kernel/errors';

async function getAuditOptions(reqId: string, h: Headers) {
  return {
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
    userAgent: h.get('user-agent'),
    requestId: reqId,
  };
}

async function getPeriod(id: string, orgId: string) {
  return prisma.financialPeriod.findFirst({
    where: { id, organizationId: orgId },
    select: {
      id: true,
      type: true,
      status: true,
      code: true,
      name: true,
      startDate: true,
      endDate: true,
      isAdjustment: true,
      reopenCount: true,
      closedAt: true,
      lockedAt: true,
    },
  });
}

import { Prisma } from '@/generated/prisma/client';

async function transitionPeriod(
  tx: Prisma.TransactionClient,
  id: string,
  orgId: string,
  newStatus: string,
  actor: { id: string; name: string; roleCodes: string[] },
  reqId: string,
  net: { ipAddress: string | null; userAgent: string | null },
  transitionName: string,
  extraChanges: Record<string, { from: unknown; to: unknown }> = {}
) {
  const existing = await tx.financialPeriod.findFirst({
    where: { id, organizationId: orgId },
    select: {
      id: true,
      type: true,
      status: true,
      code: true,
      name: true,
      reopenCount: true,
      closedAt: true,
      lockedAt: true,
    },
  });

  if (!existing) {
    throw new NotFoundError('Financial period', id);
  }

  const updateData: Record<string, unknown> = { status: newStatus };
  if (newStatus === 'CLOSED') updateData.closedAt = new Date();
  if (newStatus === 'LOCKED') updateData.lockedAt = new Date();

  const updated = await tx.financialPeriod.update({
    where: { id },
    data: updateData,
    select: {
      id: true,
      type: true,
      status: true,
      code: true,
      name: true,
      reopenCount: true,
      closedAt: true,
      lockedAt: true,
    },
  });

  await writeAuditEntry(
    tx,
    actor,
    {
      action: 'CONFIGURATION_CHANGES',
      entityType: 'FINANCIAL_PERIOD',
      entityId: updated.id,
      entityLabel: updated.code,
      description: `${transitionName} period ${updated.code} (${updated.name})`,
      changes: {
        status: { from: existing.status, to: updated.status },
        reopenCount: { from: existing.reopenCount, to: updated.reopenCount },
        closedAt: { from: existing.closedAt?.toISOString() ?? null, to: updated.closedAt?.toISOString() ?? null },
        lockedAt: { from: existing.lockedAt?.toISOString() ?? null, to: updated.lockedAt?.toISOString() ?? null },
        ...extraChanges,
      },
    },
    {
      organizationId: orgId,
      ipAddress: net.ipAddress,
      userAgent: net.userAgent,
      requestId: reqId,
      sessionId: actor.id,
    },
  );

  return updated;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'MASTER_DATA', action: 'EDIT' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const key = request.headers.get('idempotency-key');
    if (!key) {
      return apiError(
        new ValidationError('An Idempotency-Key header is required on this endpoint.'),
        reqId,
      );
    }

    const { id } = await params;
    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: `POST /api/v1/periods/${id}/open`,
      actorId: ctx.actor.userId,
      body: {},
      handler: async () =>
        withAudit(
          {
            organizationId: ctx.actor.organizationId,
            actor: {
              id: ctx.actor.userId,
              name: ctx.actor.fullName,
              roleCodes: ctx.actor.roleCodes,
            },
            ipAddress: net.ipAddress,
            userAgent: net.userAgent,
            requestId: reqId,
            sessionId: ctx.actor.sessionId,
          },
          async (tx) => {
            const existing = await getPeriod(id, ctx.actor.organizationId!);
            if (!existing) throw new NotFoundError('Financial period', id);

            if (existing.status !== 'CLOSED' && existing.status !== 'LOCKED') {
              throw new ValidationError(`Cannot open period with status ${existing.status}. Only CLOSED or LOCKED periods can be opened.`);
            }

            const updated = await transitionPeriod(
              tx,
              id,
              ctx.actor.organizationId!,
              'OPEN',
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              reqId,
              net,
              'Opened',
              { closedAt: { from: existing.closedAt?.toISOString() ?? null, to: null }, lockedAt: { from: existing.lockedAt?.toISOString() ?? null, to: null } }
            );

            return { status: 200, body: { data: updated } };
          },
        ),
    });

    if (outcome.kind === 'REPLAYED') {
      return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    }

    return ok(outcome.result, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}