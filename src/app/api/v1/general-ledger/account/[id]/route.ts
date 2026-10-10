import { NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { NotFoundError } from '@/lib/kernel/errors';

const querySchema = z.object({
  periodId: z.string().cuid().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  currency: z.string().length(3).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(500).default(50),
});

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'GENERAL_LEDGER', action: 'VIEW' });

    if (!ctx.actor.organizationId) {
      return apiError(new Error('No organization context'), reqId);
    }

    const { id } = await params;
    const url = new URL(_request.url);
    const query = querySchema.parse(Object.fromEntries(url.searchParams));

    const account = await prisma.account.findFirst({
      where: { id, organizationId: ctx.actor.organizationId },
      select: { id: true, code: true, name: true, type: true, normalBalance: true },
    });

    if (!account) {
      return apiError(new NotFoundError('Account', id), reqId);
    }

    const where: Prisma.JournalLineWhereInput = { organizationId: ctx.actor.organizationId, accountId: id };
    if (query.currency) where.currencyCode = query.currency;

    if (query.periodId) {
      const period = await prisma.financialPeriod.findFirst({
        where: { id: query.periodId, organizationId: ctx.actor.organizationId },
        select: { startDate: true, endDate: true },
      });
      if (period) {
        where.createdAt = { gte: period.startDate, lte: period.endDate };
      }
    } else if (query.startDate || query.endDate) {
      where.createdAt = {};
      if (query.startDate) where.createdAt.gte = new Date(query.startDate);
      if (query.endDate) where.createdAt.lte = new Date(query.endDate);
    }

    const [lines, total] = await Promise.all([
      prisma.journalLine.findMany({
        where,
        include: {
          entry: {
            select: {
              id: true,
              number: true,
              type: true,
              status: true,
              reference: true,
              description: true,
              postedAt: true,
              period: { select: { id: true, code: true, name: true } },
            },
          },
          project: { select: { id: true, code: true, name: true } },
          department: { select: { id: true, code: true, name: true } },
          costCentre: { select: { id: true, code: true, name: true } },
          location: { select: { id: true, code: true, name: true } },
          fundingSource: { select: { id: true, code: true, name: true } },
        },
        orderBy: [{ entry: { postedAt: 'asc' } }, { lineNumber: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.journalLine.count({ where }),
    ]);

    const openingBalance = await prisma.accountBalanceSnapshot.findFirst({
      where: {
        accountId: id,
        organizationId: ctx.actor.organizationId,
        ...(query.currency ? { currencyCode: query.currency } : { currencyCode: 'TZS' }),
        periodId: query.periodId ? undefined : { not: undefined },
      },
      orderBy: { computedAt: 'desc' },
    });

    let openingDebit = 0;
    let openingCredit = 0;
    if (openingBalance) {
      openingDebit = Number(openingBalance.debitTotal);
      openingCredit = Number(openingBalance.creditTotal);
    } else if (query.periodId) {
      const priorLines = await prisma.journalLine.findMany({
        where: {
          organizationId: ctx.actor.organizationId,
          accountId: id,
          ...(query.currency ? { currencyCode: query.currency } : {}),
          entry: { postedAt: { lt: new Date(query.startDate || '1970-01-01') } },
        },
      });
      openingDebit = priorLines.reduce((sum, l) => sum + Number(l.debit), 0);
      openingCredit = priorLines.reduce((sum, l) => sum + Number(l.credit), 0);
    }

    const linesWithBalance = lines.map((line, index) => {
      const runningDebit = openingDebit + lines.slice(0, index + 1).reduce((sum, l) => sum + Number(l.debit), 0);
      const runningCredit = openingCredit + lines.slice(0, index + 1).reduce((sum, l) => sum + Number(l.credit), 0);
      return {
        ...line,
        runningBalance: runningDebit - runningCredit,
        runningDebit,
        runningCredit,
      };
    });

    const closingDebit = openingDebit + lines.reduce((sum, l) => sum + Number(l.debit), 0);
    const closingCredit = openingCredit + lines.reduce((sum, l) => sum + Number(l.credit), 0);

    return ok({
      data: {
        account: { ...account, openingBalance: openingDebit - openingCredit, closingBalance: closingDebit - closingCredit },
        lines: linesWithBalance,
        totals: { openingDebit, openingCredit, closingDebit, closingCredit },
      },
      total,
      page: query.page,
      pageSize: query.pageSize,
    }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}