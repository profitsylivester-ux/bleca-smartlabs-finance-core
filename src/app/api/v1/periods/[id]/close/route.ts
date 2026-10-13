import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { runIdempotent } from '@/lib/api/idempotency';
import { withAudit } from '@/lib/db/with-audit';
import { NotFoundError, ValidationError } from '@/lib/kernel/errors';
import { getCloseState } from '@/lib/close/service';
import { runAllAutomatedChecks } from '@/lib/close/checks';

async function getAuditOptions(reqId: string, h: Headers) {
  return {
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
    userAgent: h.get('user-agent'),
    requestId: reqId,
  };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'FINANCIAL_CLOSE', action: 'VIEW' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const { id } = await params;
    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    // For GET, we don't need idempotency, but we still use withAudit for audit trail
    const outcome = await runIdempotent({
      key: `get-close-${id}-${ctx.actor.userId}-${Date.now()}`,
      scope: `GET /api/v1/periods/${id}/close`,
      actorId: ctx.actor.userId,
      body: {},
      handler: async () =>
        withAudit(
          {
            organizationId: ctx.actor.organizationId,
            actor: {
              id: ctx.actor.userId,
              name: ctx.actor.fullName,
              roleCodes: ctx.actor.roleCodes,
            },
            ipAddress: net.ipAddress,
            userAgent: net.userAgent,
            requestId: reqId,
            sessionId: ctx.actor.sessionId,
          },
          async (tx) => {
            const period = await tx.financialPeriod.findFirst({
              where: { id, organizationId: ctx.actor.organizationId! },
              select: { id: true, code: true, name: true, status: true, type: true },
            });

            if (!period) throw new NotFoundError('Financial period', id);

            const closeState = await getCloseState(id, ctx.actor.organizationId!);

            // If close exists, also run automated checks to get fresh results
            let automatedResults: Record<string, { passed: boolean; value: string; detail: string }> = {};
            if (closeState) {
              automatedResults = await runAllAutomatedChecks(ctx.actor.organizationId!, id);
            }

            return {
              status: 200,
              body: {
                data: {
                  period: {
                    id: period.id,
                    code: period.code,
                    name: period.name,
                    status: period.status,
                    type: period.type,
                  },
                  close: closeState,
                  automatedChecks: automatedResults,
                },
              },
            };
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