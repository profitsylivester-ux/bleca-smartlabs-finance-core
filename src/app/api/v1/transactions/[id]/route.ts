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

async function getTransactionDetail(
  id: string,
  organizationId: string,
) {
  const transaction = await prisma.transaction.findFirst({
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
      account: { select: { id: true, code: true, name: true, type: true, requiresDocument: true } },
      project: { select: { id: true, code: true, name: true } },
      department: { select: { id: true, code: true, name: true } },
      costCentre: { select: { id: true, code: true, name: true } },
      fundingSource: { select: { id: true, code: true, name: true } },
      createdBy: { select: { id: true, fullName: true } },
      submittedBy: { select: { id: true, fullName: true } },
      approvedBy: { select: { id: true, fullName: true } },
      postedBy: { select: { id: true, fullName: true } },
      journalEntries: {
        take: 1,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          number: true,
          status: true,
          lines: {
            select: {
              id: true,
              lineNumber: true,
              accountId: true,
              description: true,
              debit: true,
              credit: true,
              currencyCode: true,
              account: { select: { id: true, code: true, name: true } },
              project: { select: { id: true, code: true, name: true } },
              department: { select: { id: true, code: true, name: true } },
              costCentre: { select: { id: true, code: true, name: true } },
              fundingSource: { select: { id: true, code: true, name: true } },
            },
            orderBy: { lineNumber: 'asc' },
          },
        },
      },
    },
  });

  if (!transaction) {
    throw new NotFoundError('Transaction', id);
  }

  const auditLog = await prisma.auditLog.findMany({
    where: { entityId: id, entityType: 'JOURNAL_ENTRY', organizationId },
    orderBy: { recordedAt: 'desc' },
    select: {
      id: true,
      action: true,
      recordedAt: true,
      actorName: true,
      description: true,
      changes: true,
      metadata: true,
    },
  });

  let journalEntryPreview = null;
  if (transaction.journalEntries && transaction.journalEntries.length > 0) {
    const je = transaction.journalEntries[0];
    if (je) {
      const debits = je.lines.reduce((sum: number, line: { debit: Prisma.Decimal }) => sum + Number(line.debit), 0);
      const credits = je.lines.reduce((sum: number, line: { credit: Prisma.Decimal }) => sum + Number(line.credit), 0);
      const difference = debits - credits;
      journalEntryPreview = {
        id: je.id,
        number: je.number,
        status: je.status,
        lines: je.lines,
        balance: { debits, credits, balanced: difference === 0, difference },
      };
    }
  }

  return {
    ...transaction,
    journalEntry: journalEntryPreview,
    auditLog,
  };
}

const updateSchema = z.object({
  status: z.enum(['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'POSTED', 'LOCKED', 'ADJUSTED', 'REVERSED', 'CANCELLED']).optional(),
  description: z.string().optional(),
  reference: z.string().optional(),
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

    const searchParams = request.nextUrl.searchParams;
    const detail = searchParams.get('detail');

    if (detail === 'full') {
      const transaction = await getTransactionDetail(id, organizationId);
      return ok(transaction, 200, reqId);
    }

    const { transaction } = await getTransactionWithValidation(id, organizationId, ctx);
    return ok(transaction, 200, reqId);
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

    return ok(updated, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}