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
import type { InputJsonValue } from '@/generated/prisma/runtime/library';

const fxDifferenceTreatmentSchema = z.enum(['EXPENSE', 'INCOME', 'SUSPENSE']);

const updateSchema = z.object({
  rate: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  source: z.string().max(50).optional(),
  differenceTreatment: fxDifferenceTreatmentSchema.optional(),
});

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

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'MASTER_DATA', action: 'VIEW' });

    const { id } = await params;
    const exchangeRate = await getExchangeRate(id);
    if (!exchangeRate) {
      return apiError(new NotFoundError('Exchange rate', id), reqId);
    }

    return ok({ data: exchangeRate }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'MASTER_DATA', action: 'EDIT' });

    const key = request.headers.get('idempotency-key');
    if (!key) {
      return apiError(
        new ValidationError('An Idempotency-Key header is required on this endpoint.'),
        reqId,
      );
    }

    const { id } = await params;
    const body = updateSchema.parse(await request.json());

    const current = await getExchangeRate(id);
    if (!current) {
      return apiError(new NotFoundError('Exchange rate', id), reqId);
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: `PATCH /api/v1/exchange-rates/${id}`,
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
            const updated = await tx.exchangeRate.update({
              where: { id },
              data: {
                rate: body.rate ?? current.rate,
                source: body.source ?? current.source,
                differenceTreatment: body.differenceTreatment ?? current.differenceTreatment,
              },
              select: {
                id: true,
                baseCurrencyId: true,
                quoteCurrencyId: true,
                rateDate: true,
                rate: true,
                source: true,
                differenceTreatment: true,
              },
            });

            const changes: Record<string, { from: InputJsonValue | null; to: InputJsonValue | null }> = {};
            if (body.rate !== undefined && body.rate !== current.rate.toString())
              changes.rate = { from: current.rate.toString(), to: body.rate };
            if (body.source !== undefined && body.source !== current.source)
              changes.source = { from: current.source, to: body.source };
            if (body.differenceTreatment && body.differenceTreatment !== current.differenceTreatment)
              changes.differenceTreatment = { from: current.differenceTreatment, to: body.differenceTreatment };

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'CONFIGURATION_CHANGES',
                entityType: 'EXCHANGE_RATE',
                entityId: updated.id,
                entityLabel: `${current.baseCurrency.code}/${current.quoteCurrency.code}`,
                description: `Updated exchange rate ${current.baseCurrency.code}/${current.quoteCurrency.code}`,
                changes,
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

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'MASTER_DATA', action: 'EDIT' });

    const key = request.headers.get('idempotency-key');
    if (!key) {
      return apiError(
        new ValidationError('An Idempotency-Key header is required on this endpoint.'),
        reqId,
      );
    }

    const { id } = await params;
    const current = await getExchangeRate(id);
    if (!current) {
      return apiError(new NotFoundError('Exchange rate', id), reqId);
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: `DELETE /api/v1/exchange-rates/${id}`,
      actorId: ctx.actor.userId,
      body: { id },
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
            await tx.exchangeRate.delete({ where: { id } });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'CONFIGURATION_CHANGES',
                entityType: 'EXCHANGE_RATE',
                entityId: id,
                entityLabel: `${current.baseCurrency.code}/${current.quoteCurrency.code}`,
                description: `Deleted exchange rate ${current.baseCurrency.code}/${current.quoteCurrency.code}`,
                changes: {
                  rate: { from: current.rate.toString(), to: null },
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

            return { status: 204, body: null };
          },
        ),
    });

    if (outcome.kind === 'REPLAYED') {
      return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    }

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiError(error, reqId);
  }
}