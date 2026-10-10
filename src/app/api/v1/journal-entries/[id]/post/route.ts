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
import { postJournalEntry } from '@/lib/accounting/posting';

const postSchema = z.object({});

async function getAuditOptions(reqId: string, h: Headers) {
  return {
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
    userAgent: h.get('user-agent'),
    requestId: reqId,
  };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'JOURNAL_ENTRIES', action: 'POST' });

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
    const body = postSchema.parse(await request.json());

    const existing = await prisma.journalEntry.findFirst({
      where: { id, organizationId: ctx.actor.organizationId },
      include: {
        period: { select: { id: true, code: true, name: true, status: true } },
        lines: {
          include: { account: { select: { id: true, code: true, name: true, isPostable: true, status: true } } },
          orderBy: { lineNumber: 'asc' },
        },
      },
    });

    if (!existing) {
      return apiError(new NotFoundError('Journal entry', id), reqId);
    }

    if (existing.status !== 'APPROVED') {
      return apiError(
        new ValidationError(`Cannot post journal entry with status ${existing.status}. Only APPROVED entries can be posted.`),
        reqId,
      );
    }

    if (existing.postedById === ctx.actor.userId) {
      return apiError(
        new ValidationError('Cannot post your own submission (segregation of duties).'),
        reqId,
      );
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: `POST /api/v1/journal-entries/${id}/post`,
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
            const result = await postJournalEntry(tx, {
              entryId: id,
              actorId: ctx.actor.userId,
              actorName: ctx.actor.fullName,
              actorRoleCodes: ctx.actor.roleCodes,
              organizationId: ctx.actor.organizationId!,
              idempotencyKey: key,
            });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'JOURNAL_ENTRY_POSTED',
                entityType: 'JOURNAL_ENTRY',
                entityId: result.entry.id,
                entityLabel: result.entry.number ?? result.entry.id,
                description: `Posted journal entry ${result.entry.number ?? result.entry.id}`,
                changes: {
                  status: { from: existing.status, to: result.entry.status },
                  number: { from: existing.number ?? null, to: result.entry.number ?? null },
                  postedById: { from: null, to: result.entry.postedById },
                  postedAt: { from: null, to: result.entry.postedAt?.toISOString() ?? null },
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

            return { status: 200, body: { data: result.entry } };
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