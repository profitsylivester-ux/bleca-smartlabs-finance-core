import { NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';

const querySchema = z.object({
  accountId: z.string().cuid().optional(),
  periodId: z.string().cuid().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  projectId: z.string().cuid().optional(),
  departmentId: z.string().cuid().optional(),
  costCentreId: z.string().cuid().optional(),
  locationId: z.string().cuid().optional(),
  fundingSourceId: z.string().cuid().optional(),
  currency: z.string().length(3).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(500).default(50),
  includeZeroBalances: z.coerce.boolean().default(false),
});

export async function GET(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'GENERAL_LEDGER', action: 'VIEW' });

    if (!ctx.actor.organizationId) {
      return apiError(new Error('No organization context'), reqId);
    }

    const url = new URL(request.url);
    const query = querySchema.parse(Object.fromEntries(url.searchParams));

    const where: Prisma.JournalLineWhereInput = { organizationId: ctx.actor.organizationId };
    if (query.accountId) where.accountId = query.accountId;
    if (query.periodId) where.entry = { periodId: query.periodId };
    if (query.projectId) where.projectId = query.projectId;
    if (query.departmentId) where.departmentId = query.departmentId;
    if (query.costCentreId) where.costCentreId = query.costCentreId;
    if (query.locationId) where.locationId = query.locationId;
    if (query.fundingSourceId) where.fundingSourceId = query.fundingSourceId;
    if (query.currency) where.currencyCode = query.currency;

    if (query.startDate || query.endDate) {
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
          account: { select: { id: true, code: true, name: true, type: true } },
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

    const linesWithBalance = lines.map((line, index, arr) => {
      const prevLines = arr.slice(0, index + 1);
      const runningDebit = prevLines.reduce((sum, l) => sum + Number(l.debit), 0);
      const runningCredit = prevLines.reduce((sum, l) => sum + Number(l.credit), 0);
      return {
        ...line,
        runningBalance: runningDebit - runningCredit,
        runningDebit,
        runningCredit,
      };
    });

    return ok({ data: linesWithBalance, total, page: query.page, pageSize: query.pageSize }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}