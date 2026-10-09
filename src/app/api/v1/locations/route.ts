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

const createSchema = z.object({
  code: z.string().min(1).max(20).regex(/^[A-Z0-9_-]+$/),
  name: z.string().min(2).max(120),
  type: locationTypeSchema,
  isOwned: z.boolean().optional(),
  permissionReference: z.string().max(200).nullish(),
  parentId: z.string().cuid().nullish(),
  address: z.record(z.unknown()).nullish(),
  timezone: z.string().default('Africa/Dar_es_Salaam'),
  isActive: z.boolean().optional(),
  effectiveFrom: z.string().datetime().nullish(),
  effectiveTo: z.string().datetime().nullish(),
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

    const locations = await prisma.location.findMany({
      where: { organizationId: ctx.actor.organizationId },
      orderBy: [{ type: 'asc' }, { code: 'asc' }],
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

    return ok({ data: locations, count: locations.length }, 200, reqId);
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

    const existing = await prisma.location.findFirst({
      where: {
        organizationId: ctx.actor.organizationId,
        code: body.code,
      },
      select: { id: true },
    });
    if (existing) {
      return apiError(new ConflictError('A location with this code already exists.'), reqId);
    }

    if (body.parentId) {
      const parent = await prisma.location.findFirst({
        where: { id: body.parentId, organizationId: ctx.actor.organizationId },
        select: { id: true },
      });
      if (!parent) {
        return apiError(new NotFoundError('Parent location', body.parentId), reqId);
      }
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: 'POST /api/v1/locations',
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
            const created = await tx.location.create({
              data: {
                organizationId: ctx.actor.organizationId,
                code: body.code,
                name: body.name,
                type: body.type,
                isOwned: body.isOwned ?? false,
                permissionReference: body.permissionReference ?? undefined,
                parentId: body.parentId ?? null,
                address: body.address ?? undefined,
                timezone: body.timezone,
                isActive: body.isActive ?? true,
                effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom) : null,
                effectiveTo: body.effectiveTo ? new Date(body.effectiveTo) : null,
              },
              select: { id: true, code: true, name: true, type: true },
            });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'CONFIGURATION_CHANGES',
                entityType: 'LOCATION',
                entityId: created.id,
                entityLabel: created.code,
                description: `Created location ${created.code} (${created.name})`,
                changes: {
                  code: { from: null, to: created.code },
                  name: { from: null, to: created.name },
                  type: { from: null, to: created.type },
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