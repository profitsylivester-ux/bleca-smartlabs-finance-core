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

const reasonCodeCategorySchema = z.enum(['REVENUE', 'EXPENSE', 'TRANSFER', 'ADJUSTMENT', 'OTHER']);

const updateSchema = z.object({
  code: z.string().min(2).max(50).toUpperCase().optional(),
  name: z.string().min(2).max(120).optional(),
  description: z.string().max(500).nullish(),
  category: reasonCodeCategorySchema.optional(),
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
    const reasonCode = await prisma.reasonCode.findFirst({
      where: { id, organizationId: ctx.actor.organizationId },
      select: {
        id: true,
        code: true,
        name: true,
        description: true,
        category: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!reasonCode) {
      return apiError(new NotFoundError('Reason code', id), reqId);
    }

    return ok({ data: reasonCode }, 200, reqId);
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

    const existing = await prisma.reasonCode.findFirst({
      where: { id, organizationId: ctx.actor.organizationId },
      select: { id: true, code: true, name: true, description: true, category: true, isActive: true },
    });
    if (!existing) {
      return apiError(new NotFoundError('Reason code', id), reqId);
    }

    if (body.code && body.code !== existing.code) {
      const codeConflict = await prisma.reasonCode.findUnique({
        where: { organizationId_code: { organizationId: ctx.actor.organizationId, code: body.code } },
        select: { id: true },
      });
      if (codeConflict) {
        return apiError(new ValidationError('A reason code with this code already exists.'), reqId);
      }
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: `PATCH /api/v1/reason-codes/${id}`,
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
            const updated = await tx.reasonCode.update({
              where: { id },
              data: {
                ...(body.code && { code: body.code }),
                ...(body.name && { name: body.name }),
                ...(body.description !== undefined && { description: body.description }),
                ...(body.category && { category: body.category }),
                ...(body.isActive !== undefined && { isActive: body.isActive }),
              },
              select: { id: true, code: true, name: true, category: true, isActive: true },
            });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'CONFIGURATION_CHANGES',
                entityType: 'REASON_CODE',
                entityId: updated.id,
                entityLabel: updated.code,
                description: `Updated reason code ${updated.code}`,
                changes: {
                  code: { from: existing.code, to: updated.code },
                  name: { from: existing.name, to: updated.name },
                  category: { from: existing.category, to: updated.category },
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
    const existing = await prisma.reasonCode.findFirst({
      where: { id, organizationId: ctx.actor.organizationId },
      select: { id: true, code: true, name: true },
    });
    if (!existing) {
      return apiError(new NotFoundError('Reason code', id), reqId);
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key: `delete-${id}-${Date.now()}`,
      scope: `DELETE /api/v1/reason-codes/${id}`,
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
            await tx.reasonCode.delete({ where: { id } });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'CONFIGURATION_CHANGES',
                entityType: 'REASON_CODE',
                entityId: id,
                entityLabel: existing.code,
                description: `Deleted reason code ${existing.code} (${existing.name})`,
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