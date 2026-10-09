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
import type { InputJsonValue } from '@/generated/prisma/runtime/library';

const fxDifferenceTreatmentSchema = z.enum(['EXPENSE', 'INCOME', 'SUSPENSE']);

const createSchema = z.object({
  baseCurrencyId: z.string().cuid(),
  quoteCurrencyId: z.string().cuid(),
  rateDate: z.string().datetime(),
  rate: z.string().regex(/^\d+(\.\d+)?$/),
  source: z.string().max(50).default('MANUAL'),
  differenceTreatment: fxDifferenceTreatmentSchema.default('EXPENSE'),
});

const updateSchema = createSchema.partial();

async function getAuditOptions(reqId: string, h: Headers) {
  return {
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
    userAgent: h.get('user-agent'),
    requestId: reqId,
  };
}

async function getExchangeRate(id: string) {
  return prisma.exchangeRate.findUnique({
    where: { id },
    select: {
      id: true,
      baseCurrencyId: true,
      quoteCurrencyId: true,
      rateDate: true,
      rate: true,
      source: true,
      differenceTreatment: true,
      createdAt: true,
      updatedAt: true,
      baseCurrency: { select: { id: true, code: true, name: true } },
      quoteCurrency: { select: { id: true, code: true, name: true } },
    },
  });
}

export async function GET() {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'MASTER_DATA', action: 'VIEW' });

    const exchangeRates = await prisma.exchangeRate.findMany({
      orderBy: [{ rateDate: 'desc' }, { baseCurrencyId: 'asc' }],
      select: {
        id: true,
        baseCurrencyId: true,
        quoteCurrencyId: true,
        rateDate: true,
        rate: true,
        source: true,
        differenceTreatment: true,
        createdAt: true,
        updatedAt: true,
        baseCurrency: { select: { id: true, code: true, name: true } },
        quoteCurrency: { select: { id: true, code: true, name: true } },
      },
    });

    return ok({ data: exchangeRates, count: exchangeRates.length }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function POST(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'MASTER_DATA', action: 'CREATE' });

    const key = request.headers.get('idempotency-key');
    if (!key) {
      return apiError(
        new ValidationError('An Idempotency-Key header is required on this endpoint.'),
        reqId,
      );
    }

    const body = createSchema.parse(await request.json());

    const baseCurrency = await prisma.currency.findUnique({
      where: { id: body.baseCurrencyId },
      select: { id: true, code: true },
    });
    if (!baseCurrency) {
      return apiError(new NotFoundError('Base currency', body.baseCurrencyId), reqId);
    }

    const quoteCurrency = await prisma.currency.findUnique({
      where: { id: body.quoteCurrencyId },
      select: { id: true, code: true },
    });
    if (!quoteCurrency) {
      return apiError(new NotFoundError('Quote currency', body.quoteCurrencyId), reqId);
    }

    if (baseCurrency.id === quoteCurrency.id) {
      return apiError(new ValidationError('Base and quote currencies must be different.'), reqId);
    }

    const existing = await prisma.exchangeRate.findFirst({
      where: {
        baseCurrencyId: body.baseCurrencyId,
        quoteCurrencyId: body.quoteCurrencyId,
        rateDate: {
          gte: new Date(new Date(body.rateDate).setHours(0, 0, 0, 0)),
          lt: new Date(new Date(body.rateDate).setHours(23, 59, 59, 999)),
        },
      },
      select: { id: true },
    });
    if (existing) {
      return apiError(
        new ConflictError(
          `Exchange rate for ${baseCurrency.code}/${quoteCurrency.code} on ${new Date(body.rateDate).toISOString().split('T')[0]} already exists.`
        ),
        reqId,
      );
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: 'POST /api/v1/exchange-rates',
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
            const created = await tx.exchangeRate.create({
              data: {
                baseCurrencyId: body.baseCurrencyId,
                quoteCurrencyId: body.quoteCurrencyId,
                rateDate: new Date(body.rateDate),
                rate: body.rate,
                source: body.source,
                differenceTreatment: body.differenceTreatment,
              },
              select: {
                id: true,
                baseCurrencyId: true,
                quoteCurrencyId: true,
                rateDate: true,
                rate: true,
                differenceTreatment: true,
              },
            });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'CONFIGURATION_CHANGES',
                entityType: 'EXCHANGE_RATE',
                entityId: created.id,
                entityLabel: `${baseCurrency.code}/${quoteCurrency.code}`,
                description: `Created exchange rate ${baseCurrency.code}/${quoteCurrency.code} = ${created.rate}`,
                changes: {
                  baseCurrencyId: { from: null, to: created.baseCurrencyId },
                  quoteCurrencyId: { from: null, to: created.quoteCurrencyId },
                  rateDate: { from: null, to: created.rateDate.toISOString() },
                  rate: { from: null, to: created.rate.toString() },
                  differenceTreatment: { from: null, to: created.differenceTreatment },
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