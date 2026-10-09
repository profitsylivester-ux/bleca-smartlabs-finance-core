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
import { ConflictError, ValidationError } from '@/lib/kernel/errors';

const currencyTypeSchema = z.enum(['FIAT', 'CRYPTO', 'COMPOSITE']);

const createSchema = z.object({
  code: z.string().length(3).toUpperCase(),
  name: z.string().min(2).max(120),
  symbol: z.string().max(10).nullish(),
  type: currencyTypeSchema.default('FIAT'),
  decimalPlaces: z.number().int().min(0).max(8).default(2),
  isBase: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

const updateSchema = createSchema.partial();

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

    const currencies = await prisma.currency.findMany({
      orderBy: [{ isBase: 'desc' }, { code: 'asc' }],
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

    return ok({ data: currencies, count: currencies.length }, 200, reqId);
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

    const existing = await prisma.currency.findUnique({
      where: { code: body.code },
      select: { id: true },
    });
    if (existing) {
      return apiError(new ConflictError('A currency with this code already exists.'), reqId);
    }

    if (body.isBase) {
      const existingBase = await prisma.currency.findFirst({
        where: { isBase: true },
        select: { id: true, code: true },
      });
      if (existingBase) {
        return apiError(new ConflictError(`Base currency already exists: ${existingBase.code}`), reqId);
      }
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: 'POST /api/v1/currencies',
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
            const created = await tx.currency.create({
              data: {
                code: body.code,
                name: body.name,
                symbol: body.symbol ?? undefined,
                type: body.type,
                decimalPlaces: body.decimalPlaces,
                isBase: body.isBase ?? false,
                isActive: body.isActive ?? true,
              },
              select: { id: true, code: true, name: true, type: true, isBase: true },
            });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'CONFIGURATION_CHANGES',
                entityType: 'CURRENCY',
                entityId: created.id,
                entityLabel: created.code,
                description: `Created currency ${created.code} (${created.name})`,
                changes: {
                  code: { from: null, to: created.code },
                  name: { from: null, to: created.name },
                  type: { from: null, to: created.type },
                  isBase: { from: null, to: created.isBase },
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