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

const journalEntryTypeSchema = z.enum(['STANDARD', 'OPENING_BALANCE', 'ADJUSTMENT', 'REVERSAL', 'CORRECTION', 'CLOSING', 'SYSTEM']);
const journalEntryStatusSchema = z.enum(['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'POSTED', 'LOCKED', 'REVERSED', 'VOIDED']);
const journalSourceSchema = z.enum(['MANUAL', 'TRANSACTION', 'INVOICE', 'PAYMENT', 'RECEIPT', 'TRANSFER', 'OPENING_BALANCE', 'CLOSE', 'REVERSAL', 'IMPORT']);

const createSchema = z.object({
  periodId: z.string().cuid(),
  type: journalEntryTypeSchema.optional(),
  status: journalEntryStatusSchema.optional(),
  source: journalSourceSchema.optional(),
  reference: z.string().max(100).nullish(),
  description: z.string().max(500).nullish(),
  transactionId: z.string().cuid().nullish(),
  lines: z.array(z.object({
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
  })).min(2, 'At least 2 lines required'),
});

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

const listQuerySchema = z.object({
  periodId: z.string().cuid().optional(),
  status: journalEntryStatusSchema.optional(),
  type: journalEntryTypeSchema.optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  accountId: z.string().cuid().optional(),
  projectId: z.string().cuid().optional(),
  departmentId: z.string().cuid().optional(),
  costCentreId: z.string().cuid().optional(),
  locationId: z.string().cuid().optional(),
  fundingSourceId: z.string().cuid().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
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

export async function GET(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'JOURNAL_ENTRIES', action: 'VIEW' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const url = new URL(request.url);
    const query = listQuerySchema.parse(Object.fromEntries(url.searchParams));

    const where: Prisma.JournalEntryWhereInput = { organizationId: ctx.actor.organizationId };
    if (query.periodId) where.periodId = query.periodId;
    if (query.status) where.status = query.status;
    if (query.type) where.type = query.type;
    if (query.startDate || query.endDate) {
      where.postedAt = {};
      if (query.startDate) where.postedAt.gte = new Date(query.startDate);
      if (query.endDate) where.postedAt.lte = new Date(query.endDate);
    }

    if (query.accountId || query.projectId || query.departmentId || query.costCentreId || query.locationId || query.fundingSourceId) {
      where.lines = { some: {} };
      if (query.accountId) (where.lines.some as Prisma.JournalLineWhereInput).accountId = query.accountId;
      if (query.projectId) (where.lines.some as Prisma.JournalLineWhereInput).projectId = query.projectId;
      if (query.departmentId) (where.lines.some as Prisma.JournalLineWhereInput).departmentId = query.departmentId;
      if (query.costCentreId) (where.lines.some as Prisma.JournalLineWhereInput).costCentreId = query.costCentreId;
      if (query.locationId) (where.lines.some as Prisma.JournalLineWhereInput).locationId = query.locationId;
      if (query.fundingSourceId) (where.lines.some as Prisma.JournalLineWhereInput).fundingSourceId = query.fundingSourceId;
    }

    const [entries, total] = await Promise.all([
      prisma.journalEntry.findMany({
        where,
        orderBy: [{ postedAt: 'desc' }, { createdAt: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          period: { select: { id: true, code: true, name: true, status: true } },
          lines: {
            select: {
              id: true,
              accountId: true,
              lineNumber: true,
              debit: true,
              credit: true,
              currencyCode: true,
              baseAmount: true,
              fxRate: true,
              projectId: true,
              departmentId: true,
              costCentreId: true,
              locationId: true,
              fundingSourceId: true,
              account: { select: { id: true, code: true, name: true } },
            },
            orderBy: { lineNumber: 'asc' },
          },
          submittedBy: { select: { id: true, fullName: true } },
          approvedBy: { select: { id: true, fullName: true } },
          postedBy: { select: { id: true, fullName: true } },
        },
      }),
      prisma.journalEntry.count({ where }),
    ]);

    const entriesWithBalance = entries.map((entry) => ({
      ...entry,
      balance: calculateBalanceIndicator(entry.lines as Array<{ debit: number | Prisma.Decimal; credit: number | Prisma.Decimal }>),
    }));

    return ok({ data: entriesWithBalance, total, page: query.page, pageSize: query.pageSize }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function POST(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'JOURNAL_ENTRIES', action: 'CREATE' });

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

    const balance = calculateBalanceIndicator(body.lines as Array<{ debit: number; credit: number }>);
    if (!balance.balanced) {
      return apiError(
        new ValidationError(`Journal entry is unbalanced: debits=${balance.debits} credits=${balance.credits}`),
        reqId,
      );
    }

    const period = await prisma.financialPeriod.findFirst({
      where: { id: body.periodId, organizationId: ctx.actor.organizationId },
      select: { id: true, status: true },
    });
    if (!period) {
      return apiError(new NotFoundError('Financial period', body.periodId), reqId);
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

    if (body.transactionId) {
      const tx = await prisma.transaction.findFirst({
        where: { id: body.transactionId, organizationId: ctx.actor.organizationId },
        select: { id: true },
      });
      if (!tx) {
        return apiError(new NotFoundError('Transaction', body.transactionId), reqId);
      }
    }

    const currencies = new Set(body.lines.map((l) => l.currencyCode));
    if (currencies.size > 1) {
      return apiError(
        new ValidationError('All lines in a journal entry must share the same currency.'),
        reqId,
      );
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: 'POST /api/v1/journal-entries',
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
            const created = await tx.journalEntry.create({
              data: {
                organizationId: ctx.actor.organizationId!,
                periodId: body.periodId,
                type: body.type ?? 'STANDARD',
                status: body.status ?? 'DRAFT',
                source: body.source ?? 'MANUAL',
                reference: body.reference ?? undefined,
                description: body.description ?? undefined,
                transactionId: body.transactionId,
                lines: {
                  create: body.lines.map((line) => ({
                    organizationId: ctx.actor.organizationId!,
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
                },
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
                action: 'JOURNAL_ENTRY_CREATED',
                entityType: 'JOURNAL_ENTRY',
                entityId: created.id,
                entityLabel: created.number ?? created.id,
                description: `Created journal entry ${created.number ?? created.id}`,
                changes: {
                  periodId: { from: null, to: created.periodId },
                  type: { from: null, to: created.type },
                  status: { from: null, to: created.status },
                  source: { from: null, to: created.source },
                  reference: { from: null, to: created.reference },
                  lineCount: { from: null, to: created.lines.length },
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

            return { status: 201, body: { data: { ...created, balance: calculateBalanceIndicator(created.lines as Array<{ debit: number | Prisma.Decimal; credit: number | Prisma.Decimal }>) } } };
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