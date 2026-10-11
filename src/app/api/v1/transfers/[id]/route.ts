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

const transferStatusSchema = z.enum(['DRAFT', 'SUBMITTED', 'APPROVED', 'PROCESSED', 'FAILED', 'REVERSED', 'CANCELLED']);

const updateSchema = z.object({
  code: z.string().min(2).max(50).toUpperCase().optional(),
  sourceAccountId: z.string().cuid().optional(),
  destinationAccountId: z.string().cuid().optional(),
  amount: z.number().positive().optional(),
  currencyCode: z.string().length(3).optional(),
  destinationAmount: z.number().positive().optional(),
  destinationCurrencyCode: z.string().length(3).optional(),
  fxRate: z.number().positive().optional(),
  description: z.string().optional(),
  reference: z.string().optional(),
  status: transferStatusSchema.optional(),
});

async function getAuditOptions(reqId: string, h: Headers) {
  return {
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
    userAgent: h.get('user-agent'),
    requestId: reqId,
  };
}

async function getTransferWithRelations(id: string, orgId: string) {
  return prisma.transfer.findFirst({
    where: { id, organizationId: orgId },
    select: {
      id: true,
      code: true,
      status: true,
      sourceAccountId: true,
      destinationAccountId: true,
      amount: true,
      currencyCode: true,
      destinationAmount: true,
      destinationCurrencyCode: true,
      fxRate: true,
      description: true,
      reference: true,
      submittedAt: true,
      approvedAt: true,
      processedAt: true,
      reversedAt: true,
      createdAt: true,
      updatedAt: true,
      sourceAccount: { select: { id: true, code: true, name: true, kind: true, currencyCode: true, ledgerAccountId: true } },
      destinationAccount: { select: { id: true, code: true, name: true, kind: true, currencyCode: true, ledgerAccountId: true } },
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
    await authorize(ctx, { module: 'TREASURY_TRANSFERS', action: 'VIEW' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const { id } = await params;
    const transfer = await getTransferWithRelations(id, ctx.actor.organizationId);

    if (!transfer) {
      return apiError(new NotFoundError('Transfer', id), reqId);
    }

    return ok({ data: transfer }, 200, reqId);
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
    await authorize(ctx, { module: 'TREASURY_TRANSFERS', action: 'EDIT' });

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

    const existing = await getTransferWithRelations(id, ctx.actor.organizationId);
    if (!existing) {
      return apiError(new NotFoundError('Transfer', id), reqId);
    }

    if (existing.status !== 'DRAFT') {
      return apiError(new ValidationError('Only DRAFT transfers can be edited'), reqId);
    }

    if (body.code && body.code !== existing.code) {
      const codeConflict = await prisma.transfer.findUnique({
        where: { organizationId_code: { organizationId: ctx.actor.organizationId, code: body.code } },
        select: { id: true },
      });
      if (codeConflict) {
        return apiError(new ConflictError('A transfer with this code already exists.'), reqId);
      }
    }

    if (body.sourceAccountId && body.sourceAccountId !== existing.sourceAccountId) {
      const sa = await prisma.treasuryAccount.findFirst({
        where: { id: body.sourceAccountId, organizationId: ctx.actor.organizationId },
        select: { id: true, currencyCode: true },
      });
      if (!sa) return apiError(new NotFoundError('Source account', body.sourceAccountId), reqId);
      if (sa.currencyCode !== (body.currencyCode ?? existing.currencyCode)) {
        return apiError(new ValidationError('Source account currency must match transfer currency'), reqId);
      }
    }

    if (body.destinationAccountId && body.destinationAccountId !== existing.destinationAccountId) {
      const da = await prisma.treasuryAccount.findFirst({
        where: { id: body.destinationAccountId, organizationId: ctx.actor.organizationId },
        select: { id: true, currencyCode: true },
      });
      if (!da) return apiError(new NotFoundError('Destination account', body.destinationAccountId), reqId);
    }

    if (body.sourceAccountId && body.destinationAccountId && body.sourceAccountId === body.destinationAccountId) {
      return apiError(new ValidationError('Source and destination accounts must be different'), reqId);
    }

    const isCrossCurrency = (body.currencyCode ?? existing.currencyCode) !== (body.destinationCurrencyCode ?? existing.destinationCurrencyCode ?? existing.currencyCode);
    const sourceCurrency = body.currencyCode ?? existing.currencyCode;
    const destCurrency = body.destinationCurrencyCode ?? existing.destinationCurrencyCode ?? existing.currencyCode;

    if (isCrossCurrency) {
      if (!body.destinationAmount || !body.fxRate) {
        return apiError(new ValidationError('Cross-currency transfers require destinationAmount and fxRate'), reqId);
      }
    } else if (body.destinationAmount || body.destinationCurrencyCode || body.fxRate) {
      return apiError(new ValidationError('Same-currency transfers should not specify destinationAmount, destinationCurrencyCode, or fxRate'), reqId);
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: `PATCH /api/v1/transfers/${id}`,
      actorId: ctx.actor.userId,
      body,
      handler: async () =>
        withAudit(
          {
            organizationId: ctx.actor.organizationId,
            actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
            ipAddress: net.ipAddress,
            userAgent: net.userAgent,
            requestId: reqId,
            sessionId: ctx.actor.sessionId,
          },
          async (tx) => {
            const updateData: Record<string, unknown> = {};
            if (body.code) updateData.code = body.code;
            if (body.sourceAccountId) updateData.sourceAccountId = body.sourceAccountId;
            if (body.destinationAccountId) updateData.destinationAccountId = body.destinationAccountId;
            if (body.amount) updateData.amount = body.amount;
            if (body.currencyCode) updateData.currencyCode = body.currencyCode;
            if (body.destinationAmount !== undefined) updateData.destinationAmount = body.destinationAmount;
            if (body.destinationCurrencyCode) updateData.destinationCurrencyCode = body.destinationCurrencyCode;
            if (body.fxRate !== undefined) updateData.fxRate = body.fxRate;
            if (body.description !== undefined) updateData.description = body.description;
            if (body.reference !== undefined) updateData.reference = body.reference;
            if (body.status) updateData.status = body.status;

            const updated = await tx.transfer.update({
              where: { id },
              data: updateData,
              select: {
                id: true,
                code: true,
                status: true,
                sourceAccountId: true,
                destinationAccountId: true,
                amount: true,
                currencyCode: true,
                destinationAmount: true,
                destinationCurrencyCode: true,
                fxRate: true,
                description: true,
                reference: true,
                createdAt: true,
                updatedAt: true,
              },
            });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'CONFIGURATION_CHANGES',
                entityType: 'TRANSFER',
                entityId: updated.id,
                entityLabel: updated.code,
                description: `Updated transfer ${updated.code}`,
                changes: {
                  code: { from: existing.code, to: updated.code },
                  sourceAccountId: { from: existing.sourceAccountId, to: updated.sourceAccountId },
                  destinationAccountId: { from: existing.destinationAccountId, to: updated.destinationAccountId },
                  amount: { from: existing.amount, to: updated.amount },
                  currencyCode: { from: existing.currencyCode, to: updated.currencyCode },
                  destinationAmount: { from: existing.destinationAmount, to: updated.destinationAmount },
                  destinationCurrencyCode: { from: existing.destinationCurrencyCode, to: updated.destinationCurrencyCode },
                  fxRate: { from: existing.fxRate, to: updated.fxRate },
                  status: { from: existing.status, to: updated.status },
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
    await authorize(ctx, { module: 'TREASURY_TRANSFERS', action: 'EDIT' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const { id } = await params;
    const existing = await getTransferWithRelations(id, ctx.actor.organizationId);
    if (!existing) {
      return apiError(new NotFoundError('Transfer', id), reqId);
    }

    if (existing.status === 'PROCESSED' || existing.status === 'REVERSED') {
      return apiError(new ValidationError('Cannot delete a processed or reversed transfer'), reqId);
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key: `delete-${id}-${Date.now()}`,
      scope: `DELETE /api/v1/transfers/${id}`,
      actorId: ctx.actor.userId,
      body: {},
      handler: async () =>
        withAudit(
          {
            organizationId: ctx.actor.organizationId,
            actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
            ipAddress: net.ipAddress,
            userAgent: net.userAgent,
            requestId: reqId,
            sessionId: ctx.actor.sessionId,
          },
          async (tx) => {
            await tx.transfer.delete({ where: { id } });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'CONFIGURATION_CHANGES',
                entityType: 'TRANSFER',
                entityId: id,
                entityLabel: existing.code,
                description: `Deleted transfer ${existing.code}`,
                changes: {
                  code: { from: existing.code, to: null },
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