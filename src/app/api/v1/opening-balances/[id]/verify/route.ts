import { NextResponse } from 'next/server';
import { z } from 'zod';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { runIdempotent } from '@/lib/api/idempotency';
import { withAudit } from '@/lib/db/with-audit';
import { writeAuditEntry } from '@/lib/audit/writer';
import { NotFoundError, ValidationError } from '@/lib/kernel/errors';

const verifySchema = z.object({
  verificationNote: z.string().min(5).max(1000),
});

async function getAuditOptions(reqId: string, h: Headers) {
  return {
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
    userAgent: h.get('user-agent'),
    requestId: reqId,
  };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'MASTER_DATA', action: 'APPROVE' });

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
    const body = verifySchema.parse(await request.json());

    const existing = await prisma.openingBalance.findFirst({
      where: { id, organizationId: ctx.actor.organizationId },
      select: {
        id: true,
        accountId: true,
        periodId: true,
        amount: true,
        currencyCode: true,
        isUnverified: true,
        verificationStatus: true,
        verifiedByAccountantAt: true,
        verifiedByAccountantId: true,
        source: true,
        account: { select: { id: true, code: true, name: true } },
        period: { select: { id: true, code: true, name: true } },
      },
    });

    if (!existing) {
      return apiError(new NotFoundError('Opening balance', id), reqId);
    }

    if (existing.verificationStatus === 'VERIFIED') {
      return apiError(new ValidationError('This opening balance is already verified.'), reqId);
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: `POST /api/v1/opening-balances/${id}/verify`,
      actorId: ctx.actor.userId,
      body,
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
            const updated = await tx.openingBalance.update({
              where: { id },
              data: {
                isUnverified: false,
                verificationStatus: 'VERIFIED',
                verifiedByAccountantAt: new Date(),
                verifiedByAccountantId: ctx.actor.userId,
              },
              select: {
                id: true,
                accountId: true,
                periodId: true,
                amount: true,
                currencyCode: true,
                isUnverified: true,
                verificationStatus: true,
                verifiedByAccountantAt: true,
                verifiedByAccountantId: true,
                source: true,
                updatedAt: true,
              },
            });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'CONFIGURATION_CHANGES',
                entityType: 'OPENING_BALANCE',
                entityId: updated.id,
                entityLabel: `${existing.account?.code ?? 'Unknown'} / ${existing.period?.code ?? 'Unknown'}`,
                description: `Verified opening balance for account ${existing.account?.code ?? 'Unknown'} in period ${existing.period?.code ?? 'Unknown'}`,
                changes: {
                  isUnverified: { from: existing.isUnverified, to: updated.isUnverified },
                  verificationStatus: { from: existing.verificationStatus, to: updated.verificationStatus },
                  verifiedByAccountantAt: { from: existing.verifiedByAccountantAt?.toISOString() ?? null, to: updated.verifiedByAccountantAt?.toISOString() ?? null },
                  verifiedByAccountantId: { from: existing.verifiedByAccountantId ?? null, to: updated.verifiedByAccountantId },
                  verificationNote: { from: null, to: body.verificationNote ?? null },
                },
              },
              {
                organizationId: ctx.actor.organizationId,
                ipAddress: net.ipAddress,
                userAgent: net.userAgent,
                requestId: reqId,
                sessionId: ctx.actor.sessionId,
              },
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