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

const approveSchema = z.object({
  action: z.enum(['APPROVE', 'REJECT']),
  rejectionReason: z.string().max(500).optional(),
});

async function getAuditOptions(reqId: string, h: Headers) {
  return {
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
    userAgent: h.get('user-agent'),
    requestId: reqId,
  };
}

async function getChangeRequest(ctx: { actor: { organizationId: string | null } }, id: string) {
  if (!ctx.actor.organizationId) return null;
  return prisma.masterDataChangeRequest.findFirst({
    where: { id, organizationId: ctx.actor.organizationId },
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
    },
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'MASTER_DATA', action: 'APPROVE' });

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
    const body = approveSchema.parse(await request.json());

    const changeRequest = await getChangeRequest(ctx, id);
    if (!changeRequest) {
      return apiError(new NotFoundError('Change request', id), reqId);
    }

    if (changeRequest.status !== 'PENDING_APPROVAL') {
      return apiError(new ValidationError(`Change request is not pending approval (current status: ${changeRequest.status})`), reqId);
    }

    if (body.action === 'REJECT' && !body.rejectionReason) {
      return apiError(new ValidationError('Rejection reason is required when rejecting a change request'), reqId);
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: `POST /api/v1/master-data/changes/${id}/approve`,
      actorId: ctx.actor.userId,
      body,
      handler: async (tx): Promise<{ status: number; body: { data: { id: string; entityType: string; entityId: string | null; status: string; approvedById: string | null; approvedAt: Date | null } } }> => {
        return await withAudit(
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
          async (tx): Promise<{ status: number; body: { data: { id: string; entityType: string; entityId: string | null; status: string; approvedById: string | null; approvedAt: Date | null } } }> => {
            const newStatus = body.action === 'APPROVE' ? 'APPROVED' : 'REJECTED';
            const approvedAt = new Date();

            const updated = await tx.masterDataChangeRequest.update({
              where: { id },
              data: {
                status: newStatus,
                approvedById: ctx.actor.userId,
                approvedAt,
                ...(body.action === 'REJECT' && { reason: `${changeRequest.reason}\n\nRejection reason: ${body.rejectionReason}` }),
              },
              select: {
                id: true,
                entityType: true,
                entityId: true,
                status: true,
                approvedById: true,
                approvedAt: true,
              },
            });

            if (body.action === 'APPROVE') {
              const modelMap: Record<string, string> = {
                LOCATION: 'location',
                DEPARTMENT: 'department',
                COST_CENTRE: 'costCentre',
                PROJECT: 'project',
                FUNDING_SOURCE: 'fundingSource',
                CURRENCY: 'currency',
                EXCHANGE_RATE: 'exchangeRate',
              };
              const modelName = modelMap[changeRequest.entityType];
              if (modelName && changeRequest.entityId) {
                const modelDelegate = (tx as unknown as Record<string, {
                  findUnique: (args: { where: { id: string }; select: { id: true } }) => Promise<{ id: string } | null>;
                  update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
                  create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
                }>)[modelName];
                if (!modelDelegate) throw new ValidationError(`Unsupported entity type: ${changeRequest.entityType}`);
                const existing = await modelDelegate.findUnique({
                  where: { id: changeRequest.entityId },
                  select: { id: true },
                });
                if (existing) {
                  await modelDelegate.update({
                    where: { id: changeRequest.entityId },
                    data: changeRequest.proposedChanges as Record<string, unknown>,
                  });
                } else {
                  await modelDelegate.create({
                    data: {
                      ...(changeRequest.proposedChanges as Record<string, unknown>),
                      organizationId: ctx.actor.organizationId,
                    },
                  });
                }
              }

              const versionNumber = await tx.masterDataVersion.count({
                where: { changeRequestId: id },
              }) + 1;

              await tx.masterDataVersion.create({
                data: {
                  changeRequestId: id,
                  entityType: changeRequest.entityType,
                  entityId: changeRequest.entityId ?? null,
                  versionNumber,
                  snapshot: changeRequest.proposedChanges as InputJsonValue,
                  changedFields: changeRequest.proposedChanges as InputJsonValue,
                  effectiveFrom: changeRequest.effectiveDate ?? approvedAt,
                  effectiveTo: changeRequest.expiresAt ?? null,
                },
              });
            }

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'CONFIGURATION_CHANGES',
                entityType: 'MASTER_DATA_CHANGE_REQUEST',
                entityId: updated.id,
                entityLabel: `${updated.entityType}:${updated.entityId ?? 'new'}`,
                description: `${body.action}d master data change request for ${updated.entityType}`,
                changes: {
                  status: { from: 'PENDING_APPROVAL', to: newStatus },
                  approvedById: { from: null, to: updated.approvedById },
                  approvedAt: { from: null, to: updated.approvedAt?.toISOString() ?? null },
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
          }
        )
      }
    });

    if (outcome.kind === 'REPLAYED') {
      return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    }

    return ok(outcome.result, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}