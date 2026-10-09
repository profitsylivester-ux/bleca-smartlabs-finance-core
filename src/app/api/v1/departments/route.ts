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

const createSchema = z.object({
  code: z.string().min(1).max(20).regex(/^[A-Z0-9_-]+$/),
  name: z.string().min(2).max(120),
  parentId: z.string().cuid().nullish(),
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

    const departments = await prisma.department.findMany({
      where: { organizationId: ctx.actor.organizationId },
      orderBy: [{ code: 'asc' }],
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

    return ok({ data: departments, count: departments.length }, 200, reqId);
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

    const existing = await prisma.department.findFirst({
      where: {
        organizationId: ctx.actor.organizationId,
        code: body.code,
      },
      select: { id: true },
    });
    if (existing) {
      return apiError(new ConflictError('A department with this code already exists.'), reqId);
    }

    if (body.parentId) {
      const parent = await prisma.department.findFirst({
        where: { id: body.parentId, organizationId: ctx.actor.organizationId },
        select: { id: true },
      });
      if (!parent) {
        return apiError(new NotFoundError('Parent department', body.parentId), reqId);
      }
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: 'POST /api/v1/departments',
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
            const created = await tx.department.create({
              data: {
                organizationId: ctx.actor.organizationId!,
                code: body.code,
                name: body.name,
                parentId: body.parentId ?? null,
                isActive: body.isActive ?? true,
              },
              select: { id: true, code: true, name: true },
            });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'CONFIGURATION_CHANGES',
                entityType: 'DEPARTMENT',
                entityId: created.id,
                entityLabel: created.code,
                description: `Created department ${created.code} (${created.name})`,
                changes: {
                  code: { from: null, to: created.code },
                  name: { from: null, to: created.name },
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