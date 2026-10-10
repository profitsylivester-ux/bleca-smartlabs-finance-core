import { NextResponse } from 'next/server';
import { z } from 'zod';
import { headers } from 'next/headers';
import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { runIdempotent } from '@/lib/api/idempotency';
import { withAudit } from '@/lib/db/with-audit';
import { writeAuditEntry } from '@/lib/audit/writer';
import { NotFoundError, ValidationError } from '@/lib/kernel/errors';

const journalEntryStatusSchema = z.enum(['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'POSTED', 'LOCKED', 'REVERSED', 'VOIDED']);

const updateSchema = z.object({
  reference: z.string().max(100).nullish().optional(),
  description: z.string().max(500).nullish().optional(),
  lines: z.array(z.object({
    id: z.string().cuid().optional(),
    accountId: z.string().cuid(),
    lineNumber: z.int().positive(),
    description: z.string().max(500).nullish(),
    debit: z.number().min(0).default(0),
    credit: z.number().min(0).default(0),
    currencyCode: z.string().length(3),
    projectId: z.string().cuid().nullish(),
    departmentId: z.string().cuid().nullish(),
    costCentreId: z.string().cuid().nullish(),
    locationId: z.string().cuid().nullish(),
    fundingSourceId: z.string().cuid().nullish(),
  })).min(2).optional(),
});

async function getAuditOptions(reqId: string, h: Headers) {
  return {
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
    userAgent: h.get('user-agent'),
    requestId: reqId,
  };
}

async function getJournalEntryWithLines(id: string, orgId: string) {
  return prisma.journalEntry.findFirst({
    where: { id, organizationId: orgId },
    include: {
      period: { select: { id: true, code: true, name: true, status: true } },
      lines: {
        include: {
          account: { select: { id: true, code: true, name: true, type: true } },
          project: { select: { id: true, code: true, name: true } },
          department: { select: { id: true, code: true, name: true } },
          costCentre: { select: { id: true, code: true, name: true } },
          location: { select: { id: true, code: true, name: true } },
          fundingSource: { select: { id: true, code: true, name: true } },
        },
        orderBy: { lineNumber: 'asc' },
      },
      submittedBy: { select: { id: true, fullName: true } },
      approvedBy: { select: { id: true, fullName: true } },
      postedBy: { select: { id: true, fullName: true } },
      reversedBy: { select: { id: true, fullName: true } },
      reversalReason: { select: { id: true, code: true, name: true } },
      adjustingEntry: { select: { id: true, number: true } },
    },
  });
}

function calculateBalanceIndicator(lines: Array<{ debit: number | Prisma.Decimal; credit: number | Prisma.Decimal }>) {
  const totalDebit = lines.reduce((sum, l) => sum + Number(l.debit), 0);
  const totalCredit = lines.reduce((sum, l) => sum + Number(l.credit), 0);
  return {
    debits: totalDebit,
    credits: totalCredit,
    balanced: Math.abs(totalDebit - totalCredit) < 0.000001,
    difference: totalDebit - totalCredit,
  };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'JOURNAL_ENTRIES', action: 'VIEW' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const { id } = await params;
    const entry = await getJournalEntryWithLines(id, ctx.actor.organizationId);

    if (!entry) {
      return apiError(new NotFoundError('Journal entry', id), reqId);
    }

    return ok({ data: { ...entry, balance: calculateBalanceIndicator(entry.lines as Array<{ debit: number | Prisma.Decimal; credit: number | Prisma.Decimal }>) } }, 200, reqId);
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
    await authorize(ctx, { module: 'JOURNAL_ENTRIES', action: 'EDIT' });

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

    const existing = await getJournalEntryWithLines(id, ctx.actor.organizationId);
    if (!existing) {
      return apiError(new NotFoundError('Journal entry', id), reqId);
    }

    if (existing.status !== 'DRAFT') {
      return apiError(
        new ValidationError(`Cannot edit journal entry with status ${existing.status}. Only DRAFT entries can be edited.`),
        reqId,
      );
    }

    if (body.lines) {
      const balance = calculateBalanceIndicator(body.lines as Array<{ debit: number; credit: number }>);
      if (!balance.balanced) {
        return apiError(
          new ValidationError(`Journal entry is unbalanced: debits=${balance.debits} credits=${balance.credits}`),
          reqId,
        );
      }

      const accountIds = [...new Set(body.lines.map((l) => l.accountId))];
      const accounts = await prisma.account.findMany({
        where: { id: { in: accountIds }, organizationId: ctx.actor.organizationId },
        select: { id: true, code: true, isPostable: true, status: true },
      });
      if (accounts.length !== accountIds.length) {
        return apiError(new NotFoundError('One or more accounts not found'), reqId);
      }
      for (const acc of accounts) {
        if (!acc.isPostable || acc.status !== 'ACTIVE') {
          return apiError(new ValidationError(`Account ${acc.code} is not postable`), reqId);
        }
      }

      const currencies = new Set(body.lines.map((l) => l.currencyCode));
      if (currencies.size > 1) {
        return apiError(
          new ValidationError('All lines in a journal entry must share the same currency.'),
          reqId,
        );
      }
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: `PATCH /api/v1/journal-entries/${id}`,
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
            if (body.lines) {
              await tx.journalLine.deleteMany({ where: { entryId: id } });
              await tx.journalLine.createMany({
                data: body.lines.map((line) => ({
                  organizationId: ctx.actor.organizationId!,
                  entryId: id,
                  accountId: line.accountId,
                  lineNumber: line.lineNumber,
                  description: line.description ?? undefined,
                  debit: line.debit,
                  credit: line.credit,
                  currencyCode: line.currencyCode,
                  baseAmount: line.debit + line.credit,
                  projectId: line.projectId,
                  departmentId: line.departmentId,
                  costCentreId: line.costCentreId,
                  locationId: line.locationId,
                  fundingSourceId: line.fundingSourceId,
                })),
              });
            }

            const updated = await tx.journalEntry.update({
              where: { id },
              data: {
                ...(body.reference !== undefined && { reference: body.reference }),
                ...(body.description !== undefined && { description: body.description }),
              },
              include: {
                period: { select: { id: true, code: true, name: true, status: true } },
                lines: {
                  include: {
                    account: { select: { id: true, code: true, name: true, type: true } },
                    project: { select: { id: true, code: true, name: true } },
                    department: { select: { id: true, code: true, name: true } },
                    costCentre: { select: { id: true, code: true, name: true } },
                    location: { select: { id: true, code: true, name: true } },
                    fundingSource: { select: { id: true, code: true, name: true } },
                  },
                  orderBy: { lineNumber: 'asc' },
                },
              },
            });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'JOURNAL_ENTRY_UPDATED',
                entityType: 'JOURNAL_ENTRY',
                entityId: updated.id,
                entityLabel: updated.number ?? updated.id,
                description: `Updated journal entry ${updated.number ?? updated.id}`,
                changes: {
                  reference: { from: existing.reference ?? null, to: updated.reference ?? null },
                  description: { from: existing.description ?? null, to: updated.description ?? null },
                  lineCount: { from: existing.lines.length, to: updated.lines.length },
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

            return { status: 200, body: { data: { ...updated, balance: calculateBalanceIndicator(updated.lines as Array<{ debit: number | Prisma.Decimal; credit: number | Prisma.Decimal }>) } } };
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
    await authorize(ctx, { module: 'JOURNAL_ENTRIES', action: 'EDIT' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const { id } = await params;
    const existing = await getJournalEntryWithLines(id, ctx.actor.organizationId);
    if (!existing) {
      return apiError(new NotFoundError('Journal entry', id), reqId);
    }

    if (existing.status !== 'DRAFT' && existing.status !== 'SUBMITTED' && existing.status !== 'REJECTED' && existing.status !== 'VOIDED') {
      return apiError(
        new ValidationError(`Cannot delete journal entry with status ${existing.status}. Only DRAFT, SUBMITTED, REJECTED, or VOIDED entries can be deleted.`),
        reqId,
      );
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key: `delete-je-${id}-${Date.now()}`,
      scope: `DELETE /api/v1/journal-entries/${id}`,
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
            await tx.journalLine.deleteMany({ where: { entryId: id } });
            await tx.journalEntry.delete({ where: { id } });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'JOURNAL_ENTRY_UPDATED',
                entityType: 'JOURNAL_ENTRY',
                entityId: id,
                entityLabel: existing.number ?? id,
                description: `Deleted journal entry ${existing.number ?? id}`,
                changes: {
                  status: { from: existing.status, to: 'DELETED' },
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