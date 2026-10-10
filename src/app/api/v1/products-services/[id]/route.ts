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

const productServiceTypeSchema = z.enum(['PRODUCT', 'SERVICE']);

const updateSchema = z.object({
  code: z.string().min(2).max(50).toUpperCase().optional(),
  name: z.string().min(2).max(120).optional(),
  description: z.string().max(500).nullish(),
  type: productServiceTypeSchema.optional(),
  unit: z.string().min(1).max(20).optional(),
  unitPrice: z.string().regex(/^\d+(\.\d{1,6})?$/).nullish(),
  currencyCode: z.string().length(3).toUpperCase().optional(),
  isActive: z.boolean().optional(),
});

async function getAuditOptions(reqId: string, h: Headers) {
  return {
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
    userAgent: h.get('user-agent'),
    requestId: reqId,
  };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'MASTER_DATA', action: 'VIEW' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const { id } = await params;
    const productService = await prisma.productService.findFirst({
      where: { id, organizationId: ctx.actor.organizationId },
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

    if (!productService) {
      return apiError(new NotFoundError('Product/Service', id), reqId);
    }

    return ok({ data: productService }, 200, reqId);
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
    const body = updateSchema.parse(await request.json());

    const existing = await prisma.productService.findFirst({
      where: { id, organizationId: ctx.actor.organizationId },
      select: {
        id: true,
        code: true,
        name: true,
        description: true,
        type: true,
        unit: true,
        unitPrice: true,
        currencyCode: true,
        currency: { select: { id: true, code: true } },
        isActive: true,
      },
    });
    if (!existing) {
      return apiError(new NotFoundError('Product/Service', id), reqId);
    }

    if (body.code && body.code !== existing.code) {
      const codeConflict = await prisma.productService.findUnique({
        where: { organizationId_code: { organizationId: ctx.actor.organizationId, code: body.code } },
        select: { id: true },
      });
      if (codeConflict) {
        return apiError(new ValidationError('A product/service with this code already exists.'), reqId);
      }
    }

    let currencyCode = existing.currencyCode;
    if (body.currencyCode && body.currencyCode !== existing.currency?.code) {
      const currency = await prisma.currency.findUnique({
        where: { code: body.currencyCode },
        select: { code: true },
      });
      if (!currency) {
        return apiError(new ValidationError(`Currency ${body.currencyCode} not found`), reqId);
      }
      currencyCode = currency.code;
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: `PATCH /api/v1/products-services/${id}`,
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
            const updated = await tx.productService.update({
              where: { id },
              data: {
                ...(body.code && { code: body.code }),
                ...(body.name && { name: body.name }),
                ...(body.description !== undefined && { description: body.description }),
                ...(body.type && { type: body.type }),
                ...(body.unit && { unit: body.unit }),
                ...(body.unitPrice !== undefined && { unitPrice: body.unitPrice ? Number(body.unitPrice) : undefined }),
                ...(body.currencyCode && { currencyCode }),
                ...(body.isActive !== undefined && { isActive: body.isActive }),
              },
              select: { id: true, code: true, name: true, type: true, unit: true, isActive: true },
            });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'CONFIGURATION_CHANGES',
                entityType: 'PRODUCT_SERVICE',
                entityId: updated.id,
                entityLabel: updated.code,
                description: `Updated product/service ${updated.code}`,
                changes: {
                  code: { from: existing.code, to: updated.code },
                  name: { from: existing.name, to: updated.name },
                  type: { from: existing.type, to: updated.type },
                  isActive: { from: existing.isActive, to: updated.isActive },
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

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'MASTER_DATA', action: 'EDIT' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const { id } = await params;
    const existing = await prisma.productService.findFirst({
      where: { id, organizationId: ctx.actor.organizationId },
      select: { id: true, code: true, name: true },
    });
    if (!existing) {
      return apiError(new NotFoundError('Product/Service', id), reqId);
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key: `delete-${id}-${Date.now()}`,
      scope: `DELETE /api/v1/products-services/${id}`,
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
            await tx.productService.delete({ where: { id } });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'CONFIGURATION_CHANGES',
                entityType: 'PRODUCT_SERVICE',
                entityId: id,
                entityLabel: existing.code,
                description: `Deleted product/service ${existing.code} (${existing.name})`,
                changes: {
                  code: { from: existing.code, to: null },
                  name: { from: existing.name, to: null },
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

            return { status: 200, body: { data: { id, deleted: true } } };
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