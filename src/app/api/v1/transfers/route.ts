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

const transferStatusSchema = z.enum(['DRAFT', 'SUBMITTED', 'APPROVED', 'PROCESSED', 'FAILED', 'REVERSED', 'CANCELLED']);

const createSchema = z.object({
  code: z.string().min(2).max(50).toUpperCase(),
  sourceAccountId: z.string().cuid(),
  destinationAccountId: z.string().cuid(),
  amount: z.number().positive(),
  currencyCode: z.string().length(3),
  destinationAmount: z.number().positive().optional(),
  destinationCurrencyCode: z.string().optional(),
  fxRate: z.number().positive().optional(),
  description: z.string().optional(),
  reference: z.string().optional(),
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

    const transfers = await prisma.transfer.findMany({
      where: { organizationId: ctx.actor.organizationId },
      orderBy: [{ createdAt: 'desc' }],
      select: {
        id: true,
        code: true,
        status: true,
        sourceAccountId: true,
        destinationAccountId: true,
        amount: true,
        currencyCode: true,
        destinationAmount: true,
        destinationCurrencyCode: true,
        fxRate: true,
        description: true,
        reference: true,
        submittedAt: true,
        approvedAt: true,
        processedAt: true,
        createdAt: true,
        updatedAt: true,
        sourceAccount: { select: { id: true, code: true, name: true, kind: true } },
        destinationAccount: { select: { id: true, code: true, name: true, kind: true } },
      },
    });

    return ok({ data: transfers, count: transfers.length }, 200, reqId);
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

    if (body.sourceAccountId === body.destinationAccountId) {
      return apiError(new ValidationError('Source and destination accounts must be different'), reqId);
    }

    const sourceAccount = await prisma.treasuryAccount.findFirst({
      where: { id: body.sourceAccountId, organizationId: ctx.actor.organizationId },
      select: { id: true, code: true, name: true, currencyCode: true, kind: true, isRestricted: true, ledgerAccountId: true, ledgerAccount: { select: { id: true, normalBalance: true } } },
    });
    if (!sourceAccount) {
      return apiError(new NotFoundError('Source treasury account', body.sourceAccountId), reqId);
    }

    const destinationAccount = await prisma.treasuryAccount.findFirst({
      where: { id: body.destinationAccountId, organizationId: ctx.actor.organizationId },
      select: { id: true, code: true, name: true, currencyCode: true, kind: true, ledgerAccountId: true, ledgerAccount: { select: { id: true, normalBalance: true } } },
    });
    if (!destinationAccount) {
      return apiError(new NotFoundError('Destination treasury account', body.destinationAccountId), reqId);
    }

    if (body.currencyCode !== sourceAccount.currencyCode) {
      return apiError(new ValidationError(`Transfer currency must match source account currency (${sourceAccount.currencyCode})`), reqId);
    }

    if (body.destinationCurrencyCode && body.destinationCurrencyCode !== destinationAccount.currencyCode) {
      return apiError(new ValidationError(`Destination amount currency must match destination account currency (${destinationAccount.currencyCode})`), reqId);
    }

    const isCrossCurrency = sourceAccount.currencyCode !== destinationAccount.currencyCode;
    if (isCrossCurrency) {
      if (!body.destinationAmount || !body.destinationCurrencyCode || !body.fxRate) {
        return apiError(new ValidationError('Cross-currency transfers require destinationAmount, destinationCurrencyCode, and fxRate'), reqId);
      }
      if (body.destinationCurrencyCode !== destinationAccount.currencyCode) {
        return apiError(new ValidationError(`Destination currency must match destination account currency (${destinationAccount.currencyCode})`), reqId);
      }
    } else {
      if (body.destinationAmount || body.destinationCurrencyCode || body.fxRate) {
        return apiError(new ValidationError('Same-currency transfers should not specify destinationAmount, destinationCurrencyCode, or fxRate'), reqId);
      }
    }

    if (sourceAccount.isRestricted && sourceAccount.kind === 'GRANT_FUND') {
      return apiError(new ValidationError('Cannot transfer from restricted grant fund'), reqId);
    }

    const existing = await prisma.transfer.findUnique({
      where: { organizationId_code: { organizationId: ctx.actor.organizationId, code: body.code } },
      select: { id: true },
    });
    if (existing) {
      return apiError(new ConflictError('A transfer with this code already exists.'), reqId);
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: 'POST /api/v1/transfers',
      actorId: ctx.actor.userId,
      body,
      handler: async () =>
        withAudit(
          {
            organizationId: ctx.actor.organizationId,
            actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
            ipAddress: net.ipAddress,
            userAgent: net.userAgent,
            requestId: reqId,
            sessionId: ctx.actor.sessionId,
          },
          async (tx) => {
            const created = await tx.transfer.create({
              data: {
                organizationId: ctx.actor.organizationId!,
                code: body.code,
                status: 'DRAFT',
                sourceAccountId: body.sourceAccountId,
                destinationAccountId: body.destinationAccountId,
                amount: body.amount,
                currencyCode: body.currencyCode,
                destinationAmount: body.destinationAmount,
                destinationCurrencyCode: body.destinationCurrencyCode,
                fxRate: body.fxRate,
                description: body.description,
                reference: body.reference,
                createdAt: new Date(),
                updatedAt: new Date(),
              },
              select: {
                id: true,
                code: true,
                status: true,
                sourceAccountId: true,
                destinationAccountId: true,
                amount: true,
                currencyCode: true,
                destinationAmount: true,
                destinationCurrencyCode: true,
                fxRate: true,
                description: true,
                reference: true,
                createdAt: true,
                updatedAt: true,
              },
            });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'CONFIGURATION_CHANGES',
                entityType: 'TRANSFER',
                entityId: created.id,
                entityLabel: created.code,
                description: `Created transfer ${created.code} from ${sourceAccount.code} to ${destinationAccount.code}`,
                changes: {
                  code: { from: null, to: created.code },
                  sourceAccountId: { from: null, to: created.sourceAccountId },
                  destinationAccountId: { from: null, to: created.destinationAccountId },
                  amount: { from: null, to: created.amount },
                  currencyCode: { from: null, to: created.currencyCode },
                  destinationAmount: { from: null, to: created.destinationAmount },
                  destinationCurrencyCode: { from: null, to: created.destinationCurrencyCode },
                  fxRate: { from: null, to: created.fxRate },
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

