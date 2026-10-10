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

const reverseSchema = z.object({
  reversalReasonId: z.string().cuid(),
  full: z.boolean().default(true),
  amount: z.number().positive().optional(),
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
    select: {
      id: true,
      periodId: true,
      status: true,
      number: true,
      reference: true,
      reversedEntryId: true,
      period: { select: { id: true, code: true, name: true, status: true } },
      lines: {
        include: { account: { select: { id: true, code: true, name: true, isPostable: true, status: true } } },
        orderBy: { lineNumber: 'asc' },
      },
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
    await authorize(ctx, { module: 'JOURNAL_ENTRIES', action: 'REVERSE' });

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
    const body = reverseSchema.parse(await request.json());

    if (!body.full && !body.amount) {
      return apiError(new ValidationError('Partial reversal requires amount.'), reqId);
    }

    const existing = await getJournalEntryWithLines(id, ctx.actor.organizationId);
    if (!existing) {
      return apiError(new NotFoundError('Journal entry', id), reqId);
    }

    if (existing.status !== 'POSTED' && existing.status !== 'LOCKED') {
      return apiError(
        new ValidationError(`Cannot reverse journal entry with status ${existing.status}. Only POSTED or LOCKED entries can be reversed.`),
        reqId,
      );
    }

    if (existing.reversedEntryId) {
      return apiError(new ValidationError('Journal entry has already been reversed.'), reqId);
    }

    const reason = await prisma.reversalReasonCode.findFirst({
      where: { id: body.reversalReasonId, organizationId: ctx.actor.organizationId },
      select: { id: true },
    });
    if (!reason) {
      return apiError(new NotFoundError('Reversal reason', body.reversalReasonId), reqId);
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: `POST /api/v1/journal-entries/${id}/reverse`,
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
            const reversalNumber = await getNextJournalNumber(tx, ctx.actor.organizationId!, existing.periodId ?? '');

            const reversalLines = existing.lines.map((line, index) => ({
              organizationId: ctx.actor.organizationId!,
              accountId: line.accountId,
              lineNumber: index + 1,
              description: `Reversal of ${existing.number ?? existing.id}: ${line.description ?? ''}`,
              debit: body.full ? Number(line.credit) : Math.min(Number(line.credit), body.amount ?? 0),
              credit: body.full ? Number(line.debit) : Math.min(Number(line.debit), body.amount ?? 0),
              currencyCode: line.currencyCode,
              baseAmount: body.full ? Number(line.debit) + Number(line.credit) : Math.min(Number(line.debit) + Number(line.credit), body.amount ?? 0),
              projectId: line.projectId,
              departmentId: line.departmentId,
              costCentreId: line.costCentreId,
              locationId: line.locationId,
              fundingSourceId: line.fundingSourceId,
            }));

            const reversalEntry = await tx.journalEntry.create({
              data: {
                organizationId: ctx.actor.organizationId!,
                periodId: existing.periodId,
                type: 'REVERSAL',
                status: 'POSTED',
                source: 'REVERSAL',
                number: reversalNumber,
                reference: existing.reference,
                description: `Reversal of ${existing.number ?? existing.id}: ${body.full ? 'Full' : 'Partial'} reversal`,
                reversalReasonId: body.reversalReasonId,
                reversedEntryId: existing.id,
                postedById: ctx.actor.userId,
                postedAt: new Date(),
                lines: { create: reversalLines },
              },
              include: {
                period: { select: { id: true, code: true, name: true, status: true } },
                lines: {
                  include: {
                    account: { select: { id: true, code: true, name: true } },
                  },
                  orderBy: { lineNumber: 'asc' },
                },
              },
            });

            const updatedOriginal = await tx.journalEntry.update({
              where: { id: existing.id },
              data: {
                status: body.full ? 'REVERSED' : 'POSTED',
                reversedById: ctx.actor.userId,
                reversedAt: new Date(),
              },
              select: { id: true, status: true, reversedById: true, reversedAt: true },
            });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'JOURNAL_ENTRY_REVERSED',
                entityType: 'JOURNAL_ENTRY',
                entityId: reversalEntry.id,
                entityLabel: reversalEntry.number ?? reversalEntry.id,
                description: `Created reversal entry ${reversalEntry.number ?? reversalEntry.id} for ${existing.number ?? existing.id}`,
                changes: {
                  status: { from: null, to: 'POSTED' },
                  type: { from: null, to: 'REVERSAL' },
                  number: { from: null, to: reversalEntry.number },
                  reversedEntryId: { from: null, to: existing.id },
                  reversalReasonId: { from: null, to: body.reversalReasonId },
                  postedById: { from: null, to: ctx.actor.userId },
                  postedAt: { from: null, to: new Date().toISOString() },
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

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'JOURNAL_ENTRY_REVERSED',
                entityType: 'JOURNAL_ENTRY',
                entityId: existing.id,
                entityLabel: existing.number ?? existing.id,
                description: `${body.full ? 'Fully' : 'Partially'} reversed journal entry ${existing.number ?? existing.id}`,
                changes: {
                  status: { from: existing.status, to: updatedOriginal.status },
                  reversedById: { from: null, to: updatedOriginal.reversedById },
                  reversedAt: { from: null, to: updatedOriginal.reversedAt?.toISOString() ?? null },
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

            return { status: 200, body: { data: { reversal: reversalEntry, original: updatedOriginal } } };
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

async function getNextJournalNumber(tx: Prisma.TransactionClient, organizationId: string, periodId: string): Promise<string> {
  const lastEntry = await tx.journalEntry.findFirst({
    where: { organizationId, periodId, number: { not: null } },
    orderBy: { number: 'desc' },
    select: { number: true },
  });

  let nextNum = 1;
  if (lastEntry?.number) {
    const match = lastEntry.number.match(/^JE-(\d+)$/);
    if (match && match[1]) {
      nextNum = parseInt(match[1], 10) + 1;
    }
  }

  return `JE-${String(nextNum).padStart(6, '0')}`;
}