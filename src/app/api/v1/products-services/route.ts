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

const productServiceTypeSchema = z.enum(['PRODUCT', 'SERVICE']);

const createSchema = z.object({
  code: z.string().min(2).max(50).toUpperCase(),
  name: z.string().min(2).max(120),
  description: z.string().max(500).nullish(),
  type: productServiceTypeSchema,
  unit: z.string().min(1).max(20),
  unitPrice: z.string().regex(/^\d+(\.\d{1,6})?$/).nullish(),
  currencyCode: z.string().length(3).toUpperCase(),
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

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const productsServices = await prisma.productService.findMany({
      where: { organizationId: ctx.actor.organizationId },
      orderBy: [{ type: 'asc' }, { code: 'asc' }],
      select: {
        id: true,
        code: true,
        name: true,
        description: true,
        type: true,
        unit: true,
        unitPrice: true,
        currencyCode: true,
        currency: { select: { id: true, code: true, name: true, symbol: true } },
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return ok({ data: productsServices, count: productsServices.length }, 200, reqId);
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

    const body = createSchema.parse(await request.json());

    const existing = await prisma.productService.findUnique({
      where: { organizationId_code: { organizationId: ctx.actor.organizationId, code: body.code } },
      select: { id: true },
    });
    if (existing) {
      return apiError(new ConflictError('A product/service with this code already exists.'), reqId);
    }

    const currency = await prisma.currency.findUnique({
      where: { code: body.currencyCode },
      select: { code: true },
    });
    if (!currency) {
      return apiError(new ValidationError(`Currency ${body.currencyCode} not found`), reqId);
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: 'POST /api/v1/products-services',
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
            const created = await tx.productService.create({
              data: {
                organizationId: ctx.actor.organizationId!,
                code: body.code,
                name: body.name,
                description: body.description ?? undefined,
                type: body.type,
                unit: body.unit,
                unitPrice: body.unitPrice ? Number(body.unitPrice) : undefined,
                currencyCode: currency.code,
                isActive: body.isActive ?? true,
              },
              select: { id: true, code: true, name: true, type: true, unit: true, isActive: true },
            });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'CONFIGURATION_CHANGES',
                entityType: 'PRODUCT_SERVICE',
                entityId: created.id,
                entityLabel: created.code,
                description: `Created product/service ${created.code} (${created.name})`,
                changes: {
                  code: { from: null, to: created.code },
                  name: { from: null, to: created.name },
                  type: { from: null, to: created.type },
                  isActive: { from: null, to: created.isActive },
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