import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { runIdempotent } from '@/lib/api/idempotency';
import { withAudit } from '@/lib/db/with-audit';
import { NotFoundError, ValidationError } from '@/lib/kernel/errors';
import { writeAuditEntry } from '@/lib/audit/writer';
import { generateCloseReport } from '@/lib/close/service';

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

    const outcome = await runIdempotent({
      key: `get-close-report-${id}-${ctx.actor.userId}-${Date.now()}`,
      scope: `GET /api/v1/periods/${id}/close/report`,
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
              select: { id: true, code: true, name: true, status: true },
            });

            if (!period) throw new NotFoundError('Financial period', id);

            const report = await generateCloseReport(id, ctx.actor.organizationId!);

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'REPORT_GENERATED',
                entityType: 'FINANCIAL_CLOSE',
                entityId: report.close.id,
                entityLabel: report.period.code,
                description: `Generated close report for period ${period.code} (${period.name})`,
                metadata: {
                  periodId: id,
                  periodCode: period.code,
                  closeStatus: report.close.status,
                  canSubmit: report.summary.canSubmit,
                  canSignOff: report.summary.canSignOff,
                },
                result: 'SUCCESS',
                channel: 'WEB',
              },
              { organizationId: ctx.actor.organizationId },
            );

            return { status: 200, body: { data: report } };
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