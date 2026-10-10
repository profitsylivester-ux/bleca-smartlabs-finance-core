import { NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';

const querySchema = z.object({
  periodId: z.string().cuid().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  projectId: z.string().cuid().optional(),
  departmentId: z.string().cuid().optional(),
  costCentreId: z.string().cuid().optional(),
  fundingSourceId: z.string().cuid().optional(),
  currency: z.string().length(3).optional(),
  comparativePeriodId: z.string().cuid().optional(),
});

const REVENUE_CATEGORIES = [
  'REVENUE_TRAINING', 'REVENUE_CONSULTING', 'REVENUE_SOFTWARE', 'REVENUE_SAAS',
  'REVENUE_AI_SERVICES', 'REVENUE_IOT_SERVICES', 'REVENUE_HARDWARE', 'REVENUE_ELECTRONICS',
  'REVENUE_COMPONENT_SALES', 'REVENUE_SUBSCRIPTION', 'REVENUE_TOKEN_PACKAGES', 'REVENUE_OTHER',
];

const EXPENSE_CATEGORIES = [
  'EXPENSE_INTERNET', 'EXPENSE_CLOUD', 'EXPENSE_AI_API', 'EXPENSE_TRANSPORT',
  'EXPENSE_MARKETING', 'EXPENSE_SOFTWARE', 'EXPENSE_WORKSPACE', 'EXPENSE_SALARIES',
  'EXPENSE_TRAINING', 'EXPENSE_HARDWARE_PROTOTYPING', 'EXPENSE_OTHER',
];

async function getReportData(
  organizationId: string,
  params: { startDate?: Date; endDate?: Date; periodId?: string; projectId?: string; departmentId?: string; costCentreId?: string; fundingSourceId?: string; currency?: string }
) {
  const entryWhere: Prisma.JournalEntryWhereInput = {
    organizationId,
    status: { in: ['POSTED', 'LOCKED'] },
  };
  if (params.periodId) entryWhere.periodId = params.periodId;
  if (params.startDate || params.endDate) {
    entryWhere.postedAt = {};
    if (params.startDate) entryWhere.postedAt.gte = params.startDate;
    if (params.endDate) entryWhere.postedAt.lte = params.endDate;
  }

  const where: Prisma.JournalLineWhereInput = {
    organizationId,
    account: { type: { in: ['REVENUE', 'EXPENSE'] } },
    entry: entryWhere,
  };
  if (params.projectId) where.projectId = params.projectId;
  if (params.departmentId) where.departmentId = params.departmentId;
  if (params.costCentreId) where.costCentreId = params.costCentreId;
  if (params.fundingSourceId) where.fundingSourceId = params.fundingSourceId;
  if (params.currency) where.currencyCode = params.currency;

  const lines = await prisma.journalLine.findMany({
    where,
    include: {
      account: { select: { id: true, code: true, name: true, subCategory: true, type: true } },
    },
  });

  const revenueByCategory: Record<string, number> = {};
  const expenseByCategory: Record<string, number> = {};

  for (const line of lines) {
    const amount = Number(line.credit) - Number(line.debit);
    const cat = line.account.subCategory || 'UNCATEGORIZED';
    if (line.account.type === 'REVENUE') {
      revenueByCategory[cat] = (revenueByCategory[cat] || 0) + amount;
    } else if (line.account.type === 'EXPENSE') {
      expenseByCategory[cat] = (expenseByCategory[cat] || 0) + amount;
    }
  }

  return { revenueByCategory, expenseByCategory, lines };
}

export async function GET(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'REPORTS', action: 'VIEW' });

    if (!ctx.actor.organizationId) {
      return apiError(new Error('No organization context'), reqId);
    }

    const url = new URL(request.url);
    const query = querySchema.parse(Object.fromEntries(url.searchParams));

    let startDate: Date | undefined;
    let endDate: Date | undefined;
    const periodId = query.periodId;

    if (query.periodId) {
      const period = await prisma.financialPeriod.findFirst({
        where: { id: query.periodId, organizationId: ctx.actor.organizationId },
        select: { startDate: true, endDate: true },
      });
      if (period) {
        startDate = period.startDate;
        endDate = period.endDate;
      }
    } else {
      if (query.startDate) startDate = new Date(query.startDate);
      if (query.endDate) endDate = new Date(query.endDate);
    }

    const current = await getReportData(ctx.actor.organizationId, {
      startDate,
      endDate,
      periodId,
      projectId: query.projectId,
      departmentId: query.departmentId,
      costCentreId: query.costCentreId,
      fundingSourceId: query.fundingSourceId,
      currency: query.currency,
    });

    let comparative: typeof current | null = null;
    if (query.comparativePeriodId) {
      const compPeriod = await prisma.financialPeriod.findFirst({
        where: { id: query.comparativePeriodId, organizationId: ctx.actor.organizationId },
        select: { startDate: true, endDate: true },
      });
      if (compPeriod) {
        comparative = await getReportData(ctx.actor.organizationId, {
          startDate: compPeriod.startDate,
          endDate: compPeriod.endDate,
          projectId: query.projectId,
          departmentId: query.departmentId,
          costCentreId: query.costCentreId,
          fundingSourceId: query.fundingSourceId,
          currency: query.currency,
        });
      }
    }

    const revenueCategories = REVENUE_CATEGORIES.map(cat => ({
      category: cat,
      current: current.revenueByCategory[cat] || 0,
      comparative: comparative?.revenueByCategory[cat] || 0,
    })).filter(c => c.current !== 0 || c.comparative !== 0);

    const expenseCategories = EXPENSE_CATEGORIES.map(cat => ({
      category: cat,
      current: current.expenseByCategory[cat] || 0,
      comparative: comparative?.expenseByCategory[cat] || 0,
    })).filter(c => c.current !== 0 || c.comparative !== 0);

    const totalRevenue = revenueCategories.reduce((sum, c) => sum + c.current, 0);
    const totalExpense = expenseCategories.reduce((sum, c) => sum + c.current, 0);
    const compTotalRevenue = revenueCategories.reduce((sum, c) => sum + c.comparative, 0);
    const compTotalExpense = expenseCategories.reduce((sum, c) => sum + c.comparative, 0);

    return ok({
      data: {
        revenue: revenueCategories,
        expense: expenseCategories,
        totals: {
          revenue: { current: totalRevenue, comparative: compTotalRevenue },
          expense: { current: totalExpense, comparative: compTotalExpense },
          netSurplusDeficit: { current: totalRevenue - totalExpense, comparative: compTotalRevenue - compTotalExpense },
        },
        period: { periodId: query.periodId, startDate, endDate },
        comparativePeriod: query.comparativePeriodId,
      },
    }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}