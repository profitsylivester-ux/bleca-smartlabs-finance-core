import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { headers } from 'next/headers';
import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/kernel/errors';
import { TransactionService } from '@/lib/transactions/service';

const service = new TransactionService();
const { z: z2 } = z;

async function getTransactionWithValidation(
  id: string,
  organizationId: string,
  ctx: Awaited<ReturnType<typeof requireContext>>,
) {
  const existing = await prisma.transaction.findFirst({
    where: { id, organizationId },
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
      createdById: true,
      submittedById: true,
      approvedById: true,
      postedById: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!existing) {
    throw new NotFoundError('Transaction', id);
  }

  return { transaction: existing };
}

const updateSchema = z2.object({
  status: z.enum(['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'POSTED', 'LOCKED', 'ADJUSTED', 'REVERSED', 'CANCELLED']).optional(),
  description: z2.string().optional(),
  reference: z2.string().optional(),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ organizationId: string; id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'TRANSACTIONS', action: 'VIEW' });

    const { organizationId, id } = await params;
    const { transaction } = await getTransactionWithValidation(id, organizationId, ctx);

    return ok(transaction, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ organizationId: string; id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'TRANSACTIONS', action: 'EDIT' });

    const { organizationId, id } = await params;
    const body = updateSchema.parse(await request.json());

    const updated = await service.update(id, organizationId, body, ctx.actor);

    return ok(updated, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}