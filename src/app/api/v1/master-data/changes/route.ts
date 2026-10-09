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
import { ValidationError } from '@/lib/kernel/errors';
import type { InputJsonValue } from '@/generated/prisma/runtime/library';

const entityTypeSchema = z.enum([
  'LOCATION',
  'DEPARTMENT',
  'COST_CENTRE',
  'PROJECT',
  'FUNDING_SOURCE',
  'CURRENCY',
  'EXCHANGE_RATE',
]);

const createSchema = z.object({
  entityType: entityTypeSchema,
  entityId: z.string().cuid().nullish(),
  proposedChanges: z.record(z.string(), z.unknown()),
  reason: z.string().min(10).max(500),
  effectiveDate: z.string().datetime().nullish(),
  expiresAt: z.string().datetime().nullish(),
});

async function getAuditOptions(reqId: string, h: Headers) {
  return {
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
    userAgent: h.get('user-agent'),
    requestId: reqId,
  };
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

    if (body.entityId) {
      const modelMap: Record<string, string> = {
        LOCATION: 'location',
        DEPARTMENT: 'department',
        COST_CENTRE: 'costCentre',
        PROJECT: 'project',
        FUNDING_SOURCE: 'fundingSource',
        CURRENCY: 'currency',
        EXCHANGE_RATE: 'exchangeRate',
      };
      const modelName = modelMap[body.entityType];
      if (modelName) {
        const modelDelegate = (prisma as unknown as Record<string, {
          findFirst: (args: { where: { id: string; organizationId: string }; select: { id: true } }) => Promise<{ id: string } | null>;
        }>)[modelName];
        if (!modelDelegate) return apiError(new ValidationError(`Unsupported entity type: ${body.entityType}`), reqId);
        const exists = await modelDelegate.findFirst({
          where: { id: body.entityId, organizationId: ctx.actor.organizationId },
          select: { id: true },
        });
        if (!exists) {
          return apiError(new ValidationError(`Entity ${body.entityType} with ID ${body.entityId} not found`), reqId);
        }
      }
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: 'POST /api/v1/master-data/changes',
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
            const changeRequest = await tx.masterDataChangeRequest.create({
              data: {
                organizationId: ctx.actor.organizationId!,
                entityType: body.entityType,
                entityId: body.entityId ?? null,
                proposedChanges: body.proposedChanges as InputJsonValue,
                reason: body.reason,
                status: 'PENDING_APPROVAL',
                requestedById: ctx.actor.userId,
                effectiveDate: body.effectiveDate ? new Date(body.effectiveDate) : null,
                expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
              },
              select: {
                id: true,
                entityType: true,
                entityId: true,
                status: true,
                reason: true,
                effectiveDate: true,
                expiresAt: true,
                createdAt: true,
              },
            });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'CONFIGURATION_CHANGES',
                entityType: 'MASTER_DATA_CHANGE_REQUEST',
                entityId: changeRequest.id,
                entityLabel: `${changeRequest.entityType}:${changeRequest.entityId ?? 'new'}`,
                description: `Created master data change request for ${changeRequest.entityType}`,
                changes: {
                  entityType: { from: null, to: changeRequest.entityType },
                  entityId: { from: null, to: changeRequest.entityId },
                  status: { from: null, to: 'PENDING_APPROVAL' },
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

            return { status: 201, body: { data: changeRequest } };
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

export async function GET() {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'MASTER_DATA', action: 'VIEW' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const changes = await prisma.masterDataChangeRequest.findMany({
      where: { organizationId: ctx.actor.organizationId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        entityType: true,
        entityId: true,
        proposedChanges: true,
        reason: true,
        status: true,
        requestedById: true,
        approvedById: true,
        approvedAt: true,
        effectiveDate: true,
        expiresAt: true,
        createdAt: true,
        updatedAt: true,
        requestedBy: { select: { id: true, fullName: true, email: true } },
        approvedBy: { select: { id: true, fullName: true, email: true } },
      },
    });

    return ok({ data: changes, count: changes.length }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}