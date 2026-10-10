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
  paymentMethod: z.enum(['CASH', 'BANK_TRANSFER', 'CHECK', 'CREDIT_CARD', 'DIRECT_DEBIT', 'OTHER']).default('CASH'),
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
    const filters = {
      status: searchParams.get('status') as any,
      accountId: searchParams.get('accountId') || undefined,
      projectId: searchParams.get('projectId') || undefined,
      departmentId: searchParams.get('departmentId') || undefined,
      costCentreId: searchParams.get('costCentreId') || undefined,
      minAmount: searchParams.get('minAmount') ? Number(searchParams.get('minAmount')) : undefined,
      maxAmount: searchParams.get('maxAmount') ? Number(searchParams.get('maxAmount')) : undefined,
      startDate: searchParams.get('startDate') ? new Date(searchParams.get('startDate')) : undefined,
      endDate: searchParams.get('endDate') ? new Date(searchParams.get('endDate')) : undefined,
    };

    const transactions = await service.findAll(ctx.actor.organizationId, filters);

    return ok(transactions, reqId);
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

    const transaction = await service.create(
      { organizationId: ctx.actor.organizationId, date: new Date(body.date), ...body },
      ctx.actor,
    );

    return ok(transaction, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}