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

const currencyTypeSchema = z.enum(['FIAT', 'CRYPTO', 'COMPOSITE']);

const updateSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  symbol: z.string().max(10).nullish(),
  type: currencyTypeSchema.optional(),
  decimalPlaces: z.number().int().min(0).max(8).optional(),
  isBase: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

async function getAuditOptions(reqId: string, h: Headers) {
  return {
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
    userAgent: h.get('user-agent'),
    requestId: reqId,
  };
}

async function getCurrency(id: string) {
  return prisma.currency.findUnique({
    where: { id },
    select: {
      id: true,
      code: true,
      name: true,
      symbol: true,
      type: true,
      decimalPlaces: true,
      isBase: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
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
    const currency = await getCurrency(id);
    if (!currency) {
      return apiError(new NotFoundError('Currency', id), reqId);
    }

    return ok({ data: currency }, 200, reqId);
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

    const current = await getCurrency(id);
    if (!current) {
      return apiError(new NotFoundError('Currency', id), reqId);
    }

    if (body.isBase && body.isBase !== current.isBase) {
      const existingBase = await prisma.currency.findFirst({
        where: { isBase: true, NOT: { id } },
        select: { id: true, code: true },
      });
      if (existingBase) {
        return apiError(new ValidationError(`Base currency already exists: ${existingBase.code}`), reqId);
      }
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: `PATCH /api/v1/currencies/${id}`,
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
            const updated = await tx.currency.update({
              where: { id },
              data: {
                name: body.name ?? current.name,
                symbol: body.symbol ?? current.symbol ?? undefined,
                type: body.type ?? current.type,
                decimalPlaces: body.decimalPlaces ?? current.decimalPlaces,
                isBase: body.isBase ?? current.isBase,
                isActive: body.isActive ?? current.isActive,
              },
              select: { id: true, code: true, name: true, type: true, isBase: true, isActive: true },
            });

            const changes: Record<string, { from: InputJsonValue | null; to: InputJsonValue | null }> = {};
            if (body.name && body.name !== current.name) changes.name = { from: current.name, to: body.name };
            if (body.symbol !== undefined && body.symbol !== current.symbol) changes.symbol = { from: current.symbol, to: body.symbol };
            if (body.type && body.type !== current.type) changes.type = { from: current.type, to: body.type };
            if (body.decimalPlaces !== undefined && body.decimalPlaces !== current.decimalPlaces)
              changes.decimalPlaces = { from: current.decimalPlaces, to: body.decimalPlaces };
            if (body.isBase !== undefined && body.isBase !== current.isBase)
              changes.isBase = { from: current.isBase, to: body.isBase };
            if (body.isActive !== undefined && body.isActive !== current.isActive)
              changes.isActive = { from: current.isActive, to: body.isActive };

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'CONFIGURATION_CHANGES',
                entityType: 'CURRENCY',
                entityId: updated.id,
                entityLabel: updated.code,
                description: `Updated currency ${updated.code}`,
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
    const current = await getCurrency(id);
    if (!current) {
      return apiError(new NotFoundError('Currency', id), reqId);
    }

    if (current.isBase) {
      return apiError(new ValidationError('Cannot delete the base currency.'), reqId);
    }

    const hasRates = await prisma.exchangeRate.count({
      where: { OR: [{ baseCurrencyId: id }, { quoteCurrencyId: id }] },
    });
    if (hasRates > 0) {
      return apiError(new ValidationError('Cannot delete a currency with exchange rates.'), reqId);
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: `DELETE /api/v1/currencies/${id}`,
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
            await tx.currency.delete({ where: { id } });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'CONFIGURATION_CHANGES',
                entityType: 'CURRENCY',
                entityId: id,
                entityLabel: current.code,
                description: `Deleted currency ${current.code}`,
                changes: {
                  code: { from: current.code, to: null },
                  name: { from: current.name, to: null },
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