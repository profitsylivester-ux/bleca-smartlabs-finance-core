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

const approveSchema = z.object({});

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
        include: { account: { select: { id: true, code: true, name: true, isPostable: true, status: true } } },
        orderBy: { lineNumber: 'asc' },
      },
    },
  });
}

function calculateBalance(lines: Array<{ debit: number | Prisma.Decimal; credit: number | Prisma.Decimal }>) {
  const totalDebit = lines.reduce((sum, l) => sum + Number(l.debit), 0);
  const totalCredit = lines.reduce((sum, l) => sum + Number(l.credit), 0);
  return { totalDebit, totalCredit, balanced: Math.abs(totalDebit - totalCredit) < 0.000001 };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'JOURNAL_ENTRIES', action: 'APPROVE' });

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

    const existing = await getJournalEntryWithLines(id, ctx.actor.organizationId);
    if (!existing) {
      return apiError(new NotFoundError('Journal entry', id), reqId);
    }

    if (existing.status !== 'SUBMITTED') {
      return apiError(
        new ValidationError(`Cannot approve journal entry with status ${existing.status}. Only SUBMITTED entries can be approved.`),
        reqId,
      );
    }

    if (existing.submittedById === ctx.actor.userId) {
      return apiError(
        new ValidationError('Cannot approve your own submission (segregation of duties).'),
        reqId,
      );
    }

    const balance = calculateBalance(existing.lines as Array<{ debit: number | Prisma.Decimal; credit: number | Prisma.Decimal }>);
    if (!balance.balanced) {
      return apiError(
        new ValidationError(`Journal entry is unbalanced: debits=${balance.totalDebit} credits=${balance.totalCredit}`),
        reqId,
      );
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: `POST /api/v1/journal-entries/${id}/approve`,
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
            const updated = await tx.journalEntry.update({
              where: { id },
              data: {
                status: 'APPROVED',
                approvedById: ctx.actor.userId,
                approvedAt: new Date(),
              },
              select: {
                id: true,
                number: true,
                status: true,
                approvedById: true,
                approvedAt: true,
              },
            });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'JOURNAL_ENTRY_APPROVED',
                entityType: 'JOURNAL_ENTRY',
                entityId: updated.id,
                entityLabel: updated.number ?? updated.id,
                description: `Approved journal entry ${updated.number ?? updated.id}`,
                changes: {
                  status: { from: existing.status, to: updated.status },
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