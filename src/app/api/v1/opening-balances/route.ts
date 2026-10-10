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
import { ConflictError, NotFoundError, ValidationError } from '@/lib/kernel/errors';

const openingBalanceCreateSchema = z.object({
  accountId: z.string().cuid(),
  periodId: z.string().cuid(),
  amount: z.number().multipleOf(0.000001),
  currencyCode: z.string().length(3),
  source: z.string().min(1).max(500),
  isUnverified: z.boolean().optional(),
  verificationStatus: z.enum(['UNVERIFIED', 'PENDING_VERIFICATION', 'VERIFIED', 'DISPUTED', 'SUPERSEDED']).optional(),
});

async function getAuditOptions(reqId: string, h: Headers) {
  return {
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
    userAgent: h.get('user-agent'),
    requestId: reqId,
  };
}

export async function GET() {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'MASTER_DATA', action: 'VIEW' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const openingBalances = await prisma.openingBalance.findMany({
      where: { organizationId: ctx.actor.organizationId },
      orderBy: [{ periodId: 'asc' }, { accountId: 'asc' }],
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
        createdAt: true,
        updatedAt: true,
        account: { select: { id: true, code: true, name: true, type: true } },
        period: { select: { id: true, code: true, name: true, type: true } },
      },
    });

    return ok({ data: openingBalances, count: openingBalances.length }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function POST(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'MASTER_DATA', action: 'CREATE' });

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

    const body = openingBalanceCreateSchema.parse(await request.json());

    if (!body.source || body.source.trim() === '') {
      return apiError(new ValidationError('Source is required for opening balance entries.'), reqId);
    }

    const account = await prisma.account.findFirst({
      where: { id: body.accountId, organizationId: ctx.actor.organizationId },
      select: { id: true, code: true, name: true, isPostable: true },
    });
    if (!account) {
      return apiError(new NotFoundError('Account', body.accountId), reqId);
    }
    if (!account.isPostable) {
      return apiError(new ValidationError('Cannot post opening balance to a non-postable account.'), reqId);
    }

    const period = await prisma.financialPeriod.findFirst({
      where: { id: body.periodId, organizationId: ctx.actor.organizationId },
      select: { id: true, code: true, name: true, status: true },
    });
    if (!period) {
      return apiError(new NotFoundError('Financial period', body.periodId), reqId);
    }

    const existing = await prisma.openingBalance.findUnique({
      where: { accountId_periodId: { accountId: body.accountId, periodId: body.periodId } },
      select: { id: true },
    });
    if (existing) {
      return apiError(new ConflictError('An opening balance for this account and period already exists.'), reqId);
    }

    const currency = await prisma.currency.findUnique({
      where: { code: body.currencyCode },
      select: { code: true },
    });
    if (!currency) {
      return apiError(new NotFoundError('Currency', body.currencyCode), reqId);
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: 'POST /api/v1/opening-balances',
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
            const created = await tx.openingBalance.create({
              data: {
                organizationId: ctx.actor.organizationId!,
                accountId: body.accountId,
                periodId: body.periodId,
                amount: body.amount,
                currencyCode: body.currencyCode,
                isUnverified: body.isUnverified ?? true,
                verificationStatus: body.verificationStatus ?? 'UNVERIFIED',
                source: body.source,
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
                createdAt: true,
                updatedAt: true,
              },
            });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'CONFIGURATION_CHANGES',
                entityType: 'OPENING_BALANCE',
                entityId: created.id,
                entityLabel: `${account.code} / ${period.code}`,
                description: `Created opening balance for account ${account.code} in period ${period.code}`,
                changes: {
                  accountId: { from: null, to: created.accountId },
                  periodId: { from: null, to: created.periodId },
                  amount: { from: null, to: created.amount },
                  currencyCode: { from: null, to: created.currencyCode },
                  isUnverified: { from: null, to: created.isUnverified },
                  verificationStatus: { from: null, to: created.verificationStatus },
                  source: { from: null, to: created.source ?? null },
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

            return { status: 201, body: { data: created } };
          },
        ),
    });

    if (outcome.kind === 'REPLAYED') {
      return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    }

    return ok(outcome.result, 201, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}