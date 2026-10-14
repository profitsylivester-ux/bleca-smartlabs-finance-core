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

const treasuryAccountKindSchema = z.enum([
  'CASH', 'BANK', 'MOBILE_MONEY', 'PAYMENT_GATEWAY', 'PROJECT_FUND', 'GRANT_FUND', 'OTHER',
]);

const createSchema = z.object({
  code: z.string().min(2).max(50).toUpperCase(),
  name: z.string().min(2).max(120),
  kind: treasuryAccountKindSchema,
  currencyCode: z.string().length(3).toUpperCase(),
  ledgerAccountId: z.string().cuid(),
  locationId: z.string().cuid().nullish(),
  fundingSourceId: z.string().cuid().nullish(),
  accountNumber: z.string().max(100).nullish(),
  providerConfig: z.string().max(500).nullish(),
  isRestricted: z.boolean().optional(),
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
    await authorize(ctx, { module: 'TREASURY_TRANSFERS', action: 'VIEW' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const accounts = await prisma.treasuryAccount.findMany({
      where: { organizationId: ctx.actor.organizationId },
      orderBy: [{ kind: 'asc' }, { code: 'asc' }],
      select: {
        id: true,
        code: true,
        name: true,
        kind: true,
        currencyCode: true,
        ledgerAccountId: true,
        locationId: true,
        fundingSourceId: true,
        isActive: true,
        isRestricted: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return ok({ data: accounts, count: accounts.length }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function POST(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'TREASURY_TRANSFERS', action: 'CREATE' });

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

    const body = createSchema.parse(await request.json());

    const ledgerAccount = await prisma.account.findUnique({
      where: { id: body.ledgerAccountId },
      select: { id: true, organizationId: true, type: true, subCategory: true, isPostable: true },
    });
    if (!ledgerAccount || ledgerAccount.organizationId !== ctx.actor.organizationId) {
      return apiError(new NotFoundError('Ledger account', body.ledgerAccountId), reqId);
    }
    if (!ledgerAccount.isPostable) {
      return apiError(new ValidationError('Ledger account must be postable'), reqId);
    }

    if (body.locationId) {
      const location = await prisma.location.findUnique({
        where: { id: body.locationId },
        select: { id: true, organizationId: true },
      });
      if (!location || location.organizationId !== ctx.actor.organizationId) {
        return apiError(new NotFoundError('Location', body.locationId), reqId);
      }
    }

    if (body.fundingSourceId) {
      const fundingSource = await prisma.fundingSource.findUnique({
        where: { id: body.fundingSourceId },
        select: { id: true, organizationId: true },
      });
      if (!fundingSource || fundingSource.organizationId !== ctx.actor.organizationId) {
        return apiError(new NotFoundError('Funding source', body.fundingSourceId), reqId);
      }
    }

    const existing = await prisma.treasuryAccount.findUnique({
      where: { organizationId_code: { organizationId: ctx.actor.organizationId, code: body.code } },
      select: { id: true },
    });
    if (existing) {
      return apiError(new ConflictError('A treasury account with this code already exists.'), reqId);
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
      scope: 'POST /api/v1/treasury-accounts',
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
            const created = await tx.treasuryAccount.create({
              data: {
                organizationId: ctx.actor.organizationId!,
                code: body.code,
                name: body.name,
                kind: body.kind,
                currencyCode: body.currencyCode,
                ledgerAccountId: body.ledgerAccountId,
                locationId: body.locationId,
                fundingSourceId: body.fundingSourceId,
                accountNumberEnc: body.accountNumber,
                providerConfigEnc: body.providerConfig,
                isRestricted: body.isRestricted ?? false,
              },
              select: {
                id: true,
                code: true,
                name: true,
                kind: true,
                currencyCode: true,
                ledgerAccountId: true,
                locationId: true,
                fundingSourceId: true,
                isActive: true,
                isRestricted: true,
                createdAt: true,
                updatedAt: true,
              },
            });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'CONFIGURATION_CHANGES',
                entityType: 'TREASURY_ACCOUNT',
                entityId: created.id,
                entityLabel: created.code,
                description: `Created treasury account ${created.code} (${created.name})`,
                changes: {
                  code: { from: null, to: created.code },
                  name: { from: null, to: created.name },
                  kind: { from: null, to: created.kind },
                  currencyCode: { from: null, to: created.currencyCode },
                  ledgerAccountId: { from: null, to: created.ledgerAccountId },
                  locationId: { from: null, to: created.locationId },
                  fundingSourceId: { from: null, to: created.fundingSourceId },
                  isRestricted: { from: null, to: created.isRestricted },
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
