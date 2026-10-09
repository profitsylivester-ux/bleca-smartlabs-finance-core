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

const updateSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  parentId: z.string().cuid().nullish(),
  isActive: z.boolean().optional(),
});

async function getAuditOptions(reqId: string, h: Headers) {
  return {
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
    userAgent: h.get('user-agent'),
    requestId: reqId,
  };
}

async function getDepartment(ctx: { actor: { organizationId: string | null } }, id: string) {
  if (!ctx.actor.organizationId) return null;
  return prisma.department.findFirst({
    where: { id, organizationId: ctx.actor.organizationId },
    select: {
      id: true,
      code: true,
      name: true,
      parentId: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
      parent: { select: { id: true, code: true, name: true } },
      children: { select: { id: true, code: true, name: true } },
      _count: { select: { users: true, costCentres: true } },
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
    const department = await getDepartment(ctx, id);
    if (!department) {
      return apiError(new NotFoundError('Department', id), reqId);
    }

    return ok({ data: department }, 200, reqId);
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

    const current = await getDepartment(ctx, id);
    if (!current) {
      return apiError(new NotFoundError('Department', id), reqId);
    }

    if (body.parentId) {
      const parent = await prisma.department.findFirst({
        where: { id: body.parentId, organizationId: ctx.actor.organizationId },
        select: { id: true },
      });
      if (!parent) {
        return apiError(new NotFoundError('Parent department', body.parentId), reqId);
      }
      if (parent.id === id) {
        return apiError(new ValidationError('A department cannot be its own parent.'), reqId);
      }
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: `PATCH /api/v1/departments/${id}`,
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
            const updated = await tx.department.update({
              where: { id },
              data: {
                name: body.name ?? current.name,
                parentId: body.parentId ?? current.parentId,
                isActive: body.isActive ?? current.isActive,
              },
              select: { id: true, code: true, name: true },
            });

            const changes: Record<string, { from: InputJsonValue | null; to: InputJsonValue | null }> = {};
            if (body.name && body.name !== current.name) changes.name = { from: current.name, to: body.name };
            if (body.parentId !== undefined && body.parentId !== current.parentId)
              changes.parentId = { from: current.parentId, to: body.parentId };
            if (body.isActive !== undefined && body.isActive !== current.isActive) changes.isActive = { from: current.isActive, to: body.isActive };

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'CONFIGURATION_CHANGES',
                entityType: 'DEPARTMENT',
                entityId: updated.id,
                entityLabel: updated.code,
                description: `Updated department ${updated.code}`,
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
    const current = await getDepartment(ctx, id);
    if (!current) {
      return apiError(new NotFoundError('Department', id), reqId);
    }

    const hasChildren = await prisma.department.count({ where: { parentId: id } });
    if (hasChildren > 0) {
      return apiError(new ValidationError('Cannot delete a department with child departments.'), reqId);
    }

    const hasUsers = await prisma.user.count({ where: { homeDepartmentId: id } });
    if (hasUsers > 0) {
      return apiError(new ValidationError('Cannot delete a department assigned to users.'), reqId);
    }

    const hasCostCentres = await prisma.costCentre.count({ where: { departmentId: id } });
    if (hasCostCentres > 0) {
      return apiError(new ValidationError('Cannot delete a department with cost centres.'), reqId);
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: `DELETE /api/v1/departments/${id}`,
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
            await tx.department.delete({ where: { id } });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'CONFIGURATION_CHANGES',
                entityType: 'DEPARTMENT',
                entityId: id,
                entityLabel: current.code,
                description: `Deleted department ${current.code}`,
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