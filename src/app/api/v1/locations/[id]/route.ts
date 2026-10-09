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

const locationTypeSchema = z.enum([
  'HEAD_OFFICE',
  'OFFICE',
  'LAB',
  'WAREHOUSE',
  'PROJECT_SITE',
  'UNIVERSITY_FACILITY',
  'PERMITTED_USE',
  'REMOTE',
  'OTHER',
]);

const updateSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  type: locationTypeSchema.optional(),
  isOwned: z.boolean().optional(),
  permissionReference: z.string().max(200).nullish(),
  parentId: z.string().cuid().nullish(),
  address: z.record(z.unknown()).nullish(),
  timezone: z.string().optional(),
  isActive: z.boolean().optional(),
  effectiveFrom: z.string().datetime().nullish(),
  effectiveTo: z.string().datetime().nullish(),
});

async function getAuditOptions(reqId: string, h: Headers) {
  return {
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
    userAgent: h.get('user-agent'),
    requestId: reqId,
  };
}

async function getLocation(ctx: { actor: { organizationId: string | null } }, id: string) {
  if (!ctx.actor.organizationId) return null;
  return prisma.location.findFirst({
    where: { id, organizationId: ctx.actor.organizationId },
    select: {
      id: true,
      code: true,
      name: true,
      type: true,
      isOwned: true,
      permissionReference: true,
      parentId: true,
      address: true,
      timezone: true,
      isActive: true,
      effectiveFrom: true,
      effectiveTo: true,
      createdAt: true,
      updatedAt: true,
      parent: { select: { id: true, code: true, name: true } },
      children: { select: { id: true, code: true, name: true } },
      _count: { select: { users: true } },
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
    const location = await getLocation(ctx, id);
    if (!location) {
      return apiError(new NotFoundError('Location', id), reqId);
    }

    return ok({ data: location }, 200, reqId);
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

    const current = await getLocation(ctx, id);
    if (!current) {
      return apiError(new NotFoundError('Location', id), reqId);
    }

    if (body.parentId) {
      const parent = await prisma.location.findFirst({
        where: { id: body.parentId, organizationId: ctx.actor.organizationId },
        select: { id: true },
      });
      if (!parent) {
        return apiError(new NotFoundError('Parent location', body.parentId), reqId);
      }
      if (parent.id === id) {
        return apiError(new ValidationError('A location cannot be its own parent.'), reqId);
      }
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: `PATCH /api/v1/locations/${id}`,
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
            const updated = await tx.location.update({
              where: { id },
              data: {
                name: body.name ?? current.name,
                type: body.type ?? current.type,
                isOwned: body.isOwned ?? current.isOwned,
                permissionReference: body.permissionReference ?? (current.permissionReference ?? undefined),
                parentId: body.parentId ?? current.parentId,
                address: body.address ?? (current.address ?? undefined),
                timezone: body.timezone ?? current.timezone,
                isActive: body.isActive ?? current.isActive,
                effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom) : current.effectiveFrom,
                effectiveTo: body.effectiveTo ? new Date(body.effectiveTo) : current.effectiveTo,
              },
              select: { id: true, code: true, name: true, type: true },
            });

            const changes: Record<string, { from: unknown; to: unknown }> = {};
            if (body.name && body.name !== current.name) changes.name = { from: current.name, to: body.name };
            if (body.type && body.type !== current.type) changes.type = { from: current.type, to: body.type };
            if (body.isOwned !== undefined && body.isOwned !== current.isOwned)
              changes.isOwned = { from: current.isOwned, to: body.isOwned };
            if (body.permissionReference !== undefined && body.permissionReference !== current.permissionReference)
              changes.permissionReference = { from: current.permissionReference, to: body.permissionReference };
            if (body.parentId !== undefined && body.parentId !== current.parentId)
              changes.parentId = { from: current.parentId, to: body.parentId };
            if (body.address !== undefined && JSON.stringify(body.address) !== JSON.stringify(current.address))
              changes.address = { from: current.address, to: body.address };
            if (body.timezone && body.timezone !== current.timezone) changes.timezone = { from: current.timezone, to: body.timezone };
            if (body.isActive !== undefined && body.isActive !== current.isActive) changes.isActive = { from: current.isActive, to: body.isActive };
            if (body.effectiveFrom && new Date(body.effectiveFrom).getTime() !== current.effectiveFrom?.getTime())
              changes.effectiveFrom = { from: current.effectiveFrom, to: body.effectiveFrom };
            if (body.effectiveTo && new Date(body.effectiveTo).getTime() !== current.effectiveTo?.getTime())
              changes.effectiveTo = { from: current.effectiveTo, to: body.effectiveTo };

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'CONFIGURATION_CHANGES',
                entityType: 'LOCATION',
                entityId: updated.id,
                entityLabel: updated.code,
                description: `Updated location ${updated.code}`,
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
    const current = await getLocation(ctx, id);
    if (!current) {
      return apiError(new NotFoundError('Location', id), reqId);
    }

    const hasChildren = await prisma.location.count({ where: { parentId: id } });
    if (hasChildren > 0) {
      return apiError(new ValidationError('Cannot delete a location with child locations.'), reqId);
    }

    const hasUsers = await prisma.user.count({ where: { primaryLocationId: id } });
    if (hasUsers > 0) {
      return apiError(new ValidationError('Cannot delete a location assigned to users.'), reqId);
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: `DELETE /api/v1/locations/${id}`,
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
            await tx.location.delete({ where: { id } });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'CONFIGURATION_CHANGES',
                entityType: 'LOCATION',
                entityId: id,
                entityLabel: current.code,
                description: `Deleted location ${current.code}`,
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