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

const fundingSourceTypeSchema = z.enum(['UNRESTRICTED', 'RESTRICTED_GRANT', 'DESIGNATED', 'ENDOWMENT', 'CONTRACT_REVENUE', 'INTERNAL_ALLOCATION', 'OTHER']);

const updateSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  type: fundingSourceTypeSchema.optional(),
  description: z.string().max(500).nullish(),
  isRestricted: z.boolean().optional(),
  restrictions: z.record(z.string(), z.unknown()).nullish(),
  isActive: z.boolean().optional(),
});

async function getAuditOptions(reqId: string, h: Headers) {
  return {
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
    userAgent: h.get('user-agent'),
    requestId: reqId,
  };
}

async function getFundingSource(ctx: { actor: { organizationId: string | null } }, id: string) {
  if (!ctx.actor.organizationId) return null;
  return prisma.fundingSource.findFirst({
    where: { id, organizationId: ctx.actor.organizationId },
    select: {
      id: true,
      code: true,
      name: true,
      type: true,
      description: true,
      isRestricted: true,
      restrictions: true,
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

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const { id } = await params;
    const fundingSource = await getFundingSource(ctx, id);
    if (!fundingSource) {
      return apiError(new NotFoundError('Funding source', id), reqId);
    }

    return ok({ data: fundingSource }, 200, reqId);
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

    const current = await getFundingSource(ctx, id);
    if (!current) {
      return apiError(new NotFoundError('Funding source', id), reqId);
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: `PATCH /api/v1/funding-sources/${id}`,
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
            const updated = await tx.fundingSource.update({
              where: { id },
              data: {
                name: body.name ?? current.name,
                type: body.type ?? current.type,
                description: body.description ?? current.description,
                isRestricted: body.isRestricted ?? current.isRestricted,
                restrictions: (body.restrictions ?? current.restrictions ?? undefined) as InputJsonValue | undefined,
                isActive: body.isActive ?? current.isActive,
              },
              select: { id: true, code: true, name: true, type: true },
            });

            const changes: Record<string, { from: InputJsonValue | null; to: InputJsonValue | null }> = {};
            if (body.name && body.name !== current.name) changes.name = { from: current.name, to: body.name };
            if (body.type && body.type !== current.type) changes.type = { from: current.type, to: body.type };
            if (body.description !== undefined && body.description !== current.description)
              changes.description = { from: current.description, to: body.description };
            if (body.isRestricted !== undefined && body.isRestricted !== current.isRestricted)
              changes.isRestricted = { from: current.isRestricted, to: body.isRestricted };
            if (body.restrictions !== undefined && JSON.stringify(body.restrictions) !== JSON.stringify(current.restrictions))
              changes.restrictions = { from: current.restrictions as InputJsonValue | null, to: body.restrictions as InputJsonValue | null };
            if (body.isActive !== undefined && body.isActive !== current.isActive) changes.isActive = { from: current.isActive, to: body.isActive };

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'CONFIGURATION_CHANGES',
                entityType: 'FUNDING_SOURCE',
                entityId: updated.id,
                entityLabel: updated.code,
                description: `Updated funding source ${updated.code}`,
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
    const current = await getFundingSource(ctx, id);
    if (!current) {
      return apiError(new NotFoundError('Funding source', id), reqId);
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: `DELETE /api/v1/funding-sources/${id}`,
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
            await tx.fundingSource.delete({ where: { id } });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'CONFIGURATION_CHANGES',
                entityType: 'FUNDING_SOURCE',
                entityId: id,
                entityLabel: current.code,
                description: `Deleted funding source ${current.code}`,
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