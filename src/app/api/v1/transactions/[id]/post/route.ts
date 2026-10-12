import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { runIdempotent } from '@/lib/api/idempotency';
import { withAudit } from '@/lib/db/with-audit';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/kernel/errors';
import { TransactionService, type TransactionRow } from '@/lib/transactions/service';
import { ensureBudgetPostingApproval } from '@/lib/budgets/posting-guard';

const service = new TransactionService();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ organizationId: string; id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'TRANSACTIONS', action: 'POST' });

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
    const orgId = ctx.actor.organizationId!;

    const candidate = await prisma.transaction.findFirst({
      where: { id, organizationId: orgId },
      select: {
        id: true,
        organizationId: true,
        date: true,
        amount: true,
        currencyCode: true,
        accountId: true,
        projectId: true,
        departmentId: true,
        costCentreId: true,
        fundingSourceId: true,
        submittedById: true,
      },
    });
    if (!candidate) throw new NotFoundError('Transaction', id);

    const requestHeaders = await headers();
    const budgetApproval = await withAudit(
      {
        organizationId: orgId,
        actor: {
          id: ctx.actor.userId,
          name: ctx.actor.fullName,
          roleCodes: ctx.actor.roleCodes,
        },
        ipAddress: requestHeaders.get('x-forwarded-for')?.split(',')[0]?.trim()
          ?? requestHeaders.get('x-real-ip'),
        userAgent: requestHeaders.get('user-agent'),
        requestId: reqId,
        sessionId: ctx.actor.sessionId,
      },
      async (tx) => ensureBudgetPostingApproval(tx, candidate, ctx.actor),
    );

    if (budgetApproval.overBudget && !budgetApproval.approved) {
      return apiError(
        new ConflictError(
          'This transaction exceeds available budget. An OVER_BUDGET approval request was sent for approval.',
          {
            approvalRequestId: budgetApproval.approvalRequestId,
            budgetId: budgetApproval.budgetId,
            available: budgetApproval.available,
            projected: budgetApproval.projected,
          },
        ),
        reqId,
      );
    }

    const outcome = await runIdempotent<TransactionRow>({
      key,
      scope: `POST /api/v1/transactions/${id}/post`,
      actorId: ctx.actor.userId,
      body: {},
      handler: async () => {
        const result = await withAudit(
          {
            organizationId: orgId,
            actor: {
              id: ctx.actor.userId,
              name: ctx.actor.fullName,
              roleCodes: ctx.actor.roleCodes,
            },
            ipAddress: requestHeaders.get('x-forwarded-for')?.split(',')[0]?.trim()
              ?? requestHeaders.get('x-real-ip'),
            userAgent: requestHeaders.get('user-agent'),
            requestId: reqId,
            sessionId: ctx.actor.sessionId,
          },
          async (tx) => service._doAction(tx, id, orgId, ctx.actor, 'POSTED'),
        );
        return { status: 200, body: result };
      },
    });

    if (outcome.kind === 'REPLAYED') {
      return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    }

    return ok(outcome.result, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}
