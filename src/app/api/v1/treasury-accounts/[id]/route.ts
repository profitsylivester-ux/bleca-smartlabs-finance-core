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

const treasuryAccountKindSchema = z.enum([
  'CASH', 'BANK', 'MOBILE_MONEY', 'PAYMENT_GATEWAY', 'PROJECT_FUND', 'GRANT_FUND', 'OTHER',
]);

const updateSchema = z.object({
  code: z.string().min(2).max(50).toUpperCase().optional(),
  name: z.string().min(2).max(120).optional(),
  kind: treasuryAccountKindSchema.optional(),
  currencyCode: z.string().length(3).toUpperCase().optional(),
  ledgerAccountId: z.string().cuid().nullish().optional(),
  locationId: z.string().cuid().nullish().optional(),
  fundingSourceId: z.string().cuid().nullish().optional(),
  accountNumber: z.string().max(100).nullish().optional(),
  providerConfig: z.string().max(500).nullish().optional(),
  isActive: z.boolean().optional(),
  isRestricted: z.boolean().optional(),
});

async function getAuditOptions(reqId: string, h: Headers) {
  return {
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
    userAgent: h.get('user-agent'),
    requestId: reqId,
  };
}

async function getTreasuryAccountWithRelations(id: string, orgId: string) {
  return prisma.treasuryAccount.findFirst({
    where: { id, organizationId: orgId },
    select: {
      id: true,
      code: true,
      name: true,
      kind: true,
      currencyCode: true,
      ledgerAccountId: true,
      locationId: true,
      fundingSourceId: true,
      isActive: true,
      isRestricted: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { journalLines: true, transactions: true, paymentSchedules: true } },
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
    const account = await getTreasuryAccountWithRelations(id, ctx.actor.organizationId);

    if (!account) {
      return apiError(new NotFoundError('Treasury account', id), reqId);
    }

    return ok({ data: account }, 200, reqId);
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

    const existing = await getTreasuryAccountWithRelations(id, ctx.actor.organizationId);
    if (!existing) {
      return apiError(new NotFoundError('Treasury account', id), reqId);
    }

    if (body.code && body.code !== existing.code) {
      const codeConflict = await prisma.treasuryAccount.findUnique({
        where: { organizationId_code: { organizationId: ctx.actor.organizationId, code: body.code } },
        select: { id: true },
      });
      if (codeConflict) {
        return apiError(new ConflictError('A treasury account with this code already exists.'), reqId);
      }
    }

    if (body.ledgerAccountId) {
      const ledgerAccount = await prisma.account.findUnique({
        where: { id: body.ledgerAccountId },
        select: { id: true, organizationId: true, isPostable: true },
      });
      if (!ledgerAccount || ledgerAccount.organizationId !== ctx.actor.organizationId) {
        return apiError(new NotFoundError('Ledger account', body.ledgerAccountId), reqId);
      }
      if (!ledgerAccount.isPostable) {
        return apiError(new ValidationError('Ledger account must be postable'), reqId);
      }
    }

    if (body.locationId) {
      const location = await prisma.location.findUnique({
        where: { id: body.locationId },
        select: { id: true, organizationId: true },
      });
      if (!location || location.organizationId !== ctx.actor.organizationId) {
        return apiError(new NotFoundError('Location', body.locationId), reqId);
      }
    }

    if (body.fundingSourceId) {
      const fundingSource = await prisma.fundingSource.findUnique({
        where: { id: body.fundingSourceId },
        select: { id: true, organizationId: true },
      });
      if (!fundingSource || fundingSource.organizationId !== ctx.actor.organizationId) {
        return apiError(new NotFoundError('Funding source', body.fundingSourceId), reqId);
      }
    }

    if (body.currencyCode) {
      const currency = await prisma.currency.findUnique({
        where: { code: body.currencyCode },
        select: { code: true },
      });
      if (!currency) {
        return apiError(new NotFoundError('Currency', body.currencyCode), reqId);
      }
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: `PATCH /api/v1/treasury-accounts/${id}`,
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
            const updateData: Record<string, unknown> = {};
            if (body.code) updateData.code = body.code;
            if (body.name) updateData.name = body.name;
            if (body.kind) updateData.kind = body.kind;
            if (body.currencyCode) updateData.currencyCode = body.currencyCode;
            if (body.ledgerAccountId !== undefined) updateData.ledgerAccountId = body.ledgerAccountId;
            if (body.locationId !== undefined) updateData.locationId = body.locationId;
            if (body.fundingSourceId !== undefined) updateData.fundingSourceId = body.fundingSourceId;
            if (body.accountNumber !== undefined) updateData.accountNumberEnc = body.accountNumber;
            if (body.providerConfig !== undefined) updateData.providerConfigEnc = body.providerConfig;
            if (body.isActive !== undefined) updateData.isActive = body.isActive;
            if (body.isRestricted !== undefined) updateData.isRestricted = body.isRestricted;

            const updated = await tx.treasuryAccount.update({
              where: { id },
              data: updateData,
              select: {
                id: true,
                code: true,
                name: true,
                kind: true,
                currencyCode: true,
                ledgerAccountId: true,
                locationId: true,
                fundingSourceId: true,
                isActive: true,
                isRestricted: true,
                createdAt: true,
                updatedAt: true,
              },
            });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'CONFIGURATION_CHANGES',
                entityType: 'TREASURY_ACCOUNT',
                entityId: updated.id,
                entityLabel: updated.code,
                description: `Updated treasury account ${updated.code}`,
                changes: {
                  code: { from: existing.code, to: updated.code },
                  name: { from: existing.name, to: updated.name },
                  kind: { from: existing.kind, to: updated.kind },
                  currencyCode: { from: existing.currencyCode, to: updated.currencyCode },
                  ledgerAccountId: { from: existing.ledgerAccountId, to: updated.ledgerAccountId },
                  locationId: { from: existing.locationId, to: updated.locationId },
                  fundingSourceId: { from: existing.fundingSourceId, to: updated.fundingSourceId },
                  isActive: { from: existing.isActive, to: updated.isActive },
                  isRestricted: { from: existing.isRestricted, to: updated.isRestricted },
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
    const existing = await getTreasuryAccountWithRelations(id, ctx.actor.organizationId);
    if (!existing) {
      return apiError(new NotFoundError('Treasury account', id), reqId);
    }

    const hasLines = existing._count.journalLines > 0 || existing._count.transactions > 0 || existing._count.paymentSchedules > 0;
    if (hasLines) {
      const h = await headers();
      const net = await getAuditOptions(reqId, h);

      await withAudit(
        {
          organizationId: ctx.actor.organizationId,
          actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
          ipAddress: net.ipAddress,
          userAgent: net.userAgent,
          requestId: reqId,
          sessionId: ctx.actor.sessionId,
        },
        async (tx) => {
          await tx.treasuryAccount.update({
            where: { id },
            data: { isActive: false },
          });

          await writeAuditEntry(
            tx,
            { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
            {
              action: 'CONFIGURATION_CHANGES',
              entityType: 'TREASURY_ACCOUNT',
              entityId: id,
              entityLabel: existing.code,
              description: `Deactivated treasury account ${existing.code} (has associated lines)`,
              changes: { isActive: { from: existing.isActive, to: false } },
            },
            {
              organizationId: ctx.actor.organizationId,
              ipAddress: net.ipAddress,
              userAgent: net.userAgent,
              requestId: reqId,
              sessionId: ctx.actor.sessionId,
            },
          );

          return { status: 200, body: { data: { id, deactivated: true } } };
        },
      );

      return ok({ data: { id, deactivated: true, message: 'Treasury account has associated lines, deactivated instead of deleted' } }, 200, reqId);
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key: `delete-${id}-${Date.now()}`,
      scope: `DELETE /api/v1/treasury-accounts/${id}`,
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
            await tx.treasuryAccount.delete({ where: { id } });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'CONFIGURATION_CHANGES',
                entityType: 'TREASURY_ACCOUNT',
                entityId: id,
                entityLabel: existing.code,
                description: `Deleted treasury account ${existing.code} (${existing.name})`,
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