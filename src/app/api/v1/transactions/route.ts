import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { runIdempotent } from '@/lib/api/idempotency';
import { withAudit } from '@/lib/db/with-audit';
import { writeAuditEntry } from '@/lib/audit/writer';
import { NotFoundError, ValidationError } from '@/lib/kernel/errors';
import { TransactionService } from '@/lib/transactions/service';

const service = new TransactionService();

const createSchema = z.object({
  date: z.string().datetime(),
  description: z.string().optional(),
  reference: z.string().optional(),
  accountId: z.string().optional(),
  amount: z.number(),
  currencyCode: z.string().length(3),
  paymentMethod: z.enum(['CASH', 'BANK_TRANSFER', 'CHEQUE', 'MOBILE_MONEY', 'PAYMENT_GATEWAY', 'CARD', 'OTHER']).default('CASH'),
  projectId: z.string().optional(),
  departmentId: z.string().optional(),
  costCentreId: z.string().optional(),
  fundingSourceId: z.string().optional(),
  supportingDocumentId: z.string().optional(),
});

const updateSchema = z.object({
  status: z.enum(['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'POSTED', 'LOCKED', 'ADJUSTED', 'REVERSED', 'CANCELLED']).optional(),
  description: z.string().optional(),
  reference: z.string().optional(),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ organizationId: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'TRANSACTIONS', action: 'VIEW' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') || '20', 10)));
    const sortBy = searchParams.get('sortBy') || 'date';
    const sortOrder = (searchParams.get('sortOrder') || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
    const isExport = searchParams.get('export') === 'csv';

    const filters = {
      status: searchParams.get('status') || undefined,
      accountId: searchParams.get('accountId') || undefined,
      projectId: searchParams.get('projectId') || undefined,
      departmentId: searchParams.get('departmentId') || undefined,
      costCentreId: searchParams.get('costCentreId') || undefined,
      fundingSourceId: searchParams.get('fundingSourceId') || undefined,
      minAmount: searchParams.get('minAmount') ? Number(searchParams.get('minAmount')) : undefined,
      maxAmount: searchParams.get('maxAmount') ? Number(searchParams.get('maxAmount')) : undefined,
      startDate: searchParams.get('startDate') ? new Date(searchParams.get('startDate')!) : undefined,
      endDate: searchParams.get('endDate') ? new Date(searchParams.get('endDate')!) : undefined,
      search: searchParams.get('search') || undefined,
    };

    const where: Record<string, unknown> = { organizationId: ctx.actor.organizationId };

    if (filters.status) where.status = filters.status;
    if (filters.accountId) where.accountId = filters.accountId;
    if (filters.projectId) where.projectId = filters.projectId;
    if (filters.departmentId) where.departmentId = filters.departmentId;
    if (filters.costCentreId) where.costCentreId = filters.costCentreId;
    if (filters.fundingSourceId) where.fundingSourceId = filters.fundingSourceId;
    if (filters.minAmount !== undefined || filters.maxAmount !== undefined) {
      where.amount = {};
      if (filters.minAmount !== undefined) (where.amount as Record<string, number>).gte = filters.minAmount;
      if (filters.maxAmount !== undefined) (where.amount as Record<string, number>).lte = filters.maxAmount;
    }
    if (filters.startDate || filters.endDate) {
      where.date = {};
      if (filters.startDate) (where.date as Record<string, Date>).gte = filters.startDate;
      if (filters.endDate) (where.date as Record<string, Date>).lte = filters.endDate;
    }
    if (filters.search) {
      where.OR = [
        { description: { contains: filters.search, mode: 'insensitive' } },
        { reference: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    const orderBy: Record<string, 'asc' | 'desc'> = { [sortBy]: sortOrder };

    const [transactions, total] = await Promise.all([
      prisma.transaction.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: isExport ? undefined : pageSize,
        select: {
          id: true,
          status: true,
          date: true,
          description: true,
          reference: true,
          amount: true,
          currencyCode: true,
          paymentMethod: true,
          accountId: true,
          projectId: true,
          departmentId: true,
          costCentreId: true,
          fundingSourceId: true,
          supportingDocumentId: true,
          createdAt: true,
          updatedAt: true,
          account: { select: { id: true, code: true, name: true } },
          project: { select: { id: true, code: true, name: true } },
          department: { select: { id: true, code: true, name: true } },
          costCentre: { select: { id: true, code: true, name: true } },
          fundingSource: { select: { id: true, code: true, name: true } },
        },
      }),
      prisma.transaction.count({ where }),
    ]);

    const data = transactions.map((tx) => ({
      id: tx.id,
      status: tx.status,
      date: tx.date.toISOString(),
      description: tx.description,
      reference: tx.reference,
      amount: Number(tx.amount),
      currencyCode: tx.currencyCode,
      paymentMethod: tx.paymentMethod,
      accountId: tx.accountId,
      projectId: tx.projectId,
      departmentId: tx.departmentId,
      costCentreId: tx.costCentreId,
      fundingSourceId: tx.fundingSourceId,
      supportingDocumentId: tx.supportingDocumentId,
      createdAt: tx.createdAt.toISOString(),
      updatedAt: tx.updatedAt.toISOString(),
      account: tx.account,
      project: tx.project,
      department: tx.department,
      costCentre: tx.costCentre,
      fundingSource: tx.fundingSource,
    }));

    if (isExport) {
      const headers = [
        'ID',
        'Status',
        'Date',
        'Reference',
        'Description',
        'Amount',
        'Currency',
        'Payment Method',
        'Account ID',
        'Account Code',
        'Account Name',
        'Project ID',
        'Project Code',
        'Project Name',
        'Department ID',
        'Department Code',
        'Department Name',
        'Cost Centre ID',
        'Cost Centre Code',
        'Cost Centre Name',
        'Funding Source ID',
        'Funding Source Code',
        'Funding Source Name',
        'Created At',
        'Updated At',
      ];

      const rows = data.map((tx) => [
        tx.id,
        tx.status ?? '',
        tx.date,
        tx.reference ?? '',
        tx.description ?? '',
        String(tx.amount),
        tx.currencyCode,
        tx.paymentMethod,
        tx.accountId ?? '',
        tx.account?.code ?? '',
        tx.account?.name ?? '',
        tx.projectId ?? '',
        tx.project?.code ?? '',
        tx.project?.name ?? '',
        tx.departmentId ?? '',
        tx.department?.code ?? '',
        tx.department?.name ?? '',
        tx.costCentreId ?? '',
        tx.costCentre?.code ?? '',
        tx.costCentre?.name ?? '',
        tx.fundingSourceId ?? '',
        tx.fundingSource?.code ?? '',
        tx.fundingSource?.name ?? '',
        tx.createdAt,
        tx.updatedAt,
      ]);

      const csv = [headers.join(','), ...rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))].join('\n');

      return new NextResponse(csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="transactions-${new Date().toISOString().split('T')[0]}.csv"`,
        },
      });
    }

    return ok({ data, total, page, pageSize }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ organizationId: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'TRANSACTIONS', action: 'CREATE' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const body = createSchema.parse(await request.json());
    const { date, ...rest } = body;

    const transaction = await service.create(
      { organizationId: ctx.actor.organizationId, date: new Date(date), ...rest },
      ctx.actor,
    );

    return ok(transaction, 201, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}