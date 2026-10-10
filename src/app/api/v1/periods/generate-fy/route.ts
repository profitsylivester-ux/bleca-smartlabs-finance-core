import { NextResponse } from 'next/server';
import { z } from 'zod';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { runIdempotent } from '@/lib/api/idempotency';
import { withAudit } from '@/lib/db/with-audit';
import { writeAuditEntry } from '@/lib/audit/writer';
import { ValidationError } from '@/lib/kernel/errors';

const generateFySchema = z.object({
  fiscalYear: z.number().int().min(2000).max(2100),
});

async function getAuditOptions(reqId: string, h: Headers) {
  return {
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
    userAgent: h.get('user-agent'),
    requestId: reqId,
  };
}

function getMonthEndDate(year: number, month: number): Date {
  return new Date(Date.UTC(year, month + 1, 0, 23, 59, 59));
}

function getQuarterEndDate(year: number, quarter: number): Date {
  const endMonth = quarter * 3 - 1;
  return new Date(Date.UTC(year, endMonth + 1, 0, 23, 59, 59));
}

export async function POST(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'MASTER_DATA', action: 'CREATE' });

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

    const body = generateFySchema.parse(await request.json());
    const year = body.fiscalYear;

    const org = await prisma.organization.findUnique({
      where: { id: ctx.actor.organizationId },
      select: { fiscalYearStartMonth: true, fiscalYearEndDay: true },
    });

    if (!org) {
      return apiError(new ValidationError('Organization not found'), reqId);
    }

    const startMonth = org.fiscalYearStartMonth - 1; // Convert to 0-indexed
    const endDay = org.fiscalYearEndDay;

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: `POST /api/v1/periods/generate-fy`,
      actorId: ctx.actor.userId,
      body,
      handler: async () =>
        withAudit(
          {
            organizationId: ctx.actor.organizationId!,
            actor: {
              id: ctx.actor.userId,
              name: ctx.actor.fullName,
              roleCodes: ctx.actor.roleCodes,
            },
            ipAddress: net.ipAddress,
            userAgent: net.userAgent,
            requestId: reqId,
            sessionId: ctx.actor.sessionId ?? undefined,
          },
          async (tx) => {
            const existingCount = await tx.financialPeriod.count({
              where: {
                organizationId: ctx.actor.organizationId!,
                OR: [
                  { code: { startsWith: `${year}-` } },
                  { code: `${year}` },
                ],
              },
            });

            if (existingCount > 0) {
              throw new ValidationError(`Periods for fiscal year ${year} already exist.`);
            }

            const created: Array<{ type: string; code: string; name: string }> = [];

            // Monthly periods
            for (let i = 0; i < 12; i++) {
              const month = (startMonth + i) % 12;
              const yearOffset = startMonth + i >= 12 ? 1 : 0;
              const periodYear = year + yearOffset;
              const startDate = new Date(Date.UTC(periodYear, month, 1));
              const endDate = getMonthEndDate(periodYear, month);

              const code = `${periodYear}-${String(month + 1).padStart(2, '0')}`;
              const name = `${periodYear}-${String(month + 1).padStart(2, '0')}`;

              await tx.financialPeriod.create({
                data: {
                  organizationId: ctx.actor.organizationId!,
                  type: 'MONTHLY',
                  status: 'OPEN',
                  code,
                  name,
                  startDate,
                  endDate,
                },
              });

              created.push({ type: 'MONTHLY', code, name });
            }

            // Quarterly periods
            for (let q = 0; q < 4; q++) {
              const quarterStartMonth = (startMonth + q * 3) % 12;
              const quarterYearOffset = Math.floor((startMonth + q * 3) / 12);
              const periodYear = year + quarterYearOffset;

              const startDate = new Date(Date.UTC(periodYear, quarterStartMonth, 1));
              const endDate = getQuarterEndDate(periodYear, quarterStartMonth / 3 + 1);

              const code = `${periodYear}-Q${q + 1}`;
              const name = `Q${q + 1} ${periodYear}`;

              await tx.financialPeriod.create({
                data: {
                  organizationId: ctx.actor.organizationId!,
                  type: 'QUARTERLY',
                  status: 'OPEN',
                  code,
                  name,
                  startDate,
                  endDate,
                },
              });

              created.push({ type: 'QUARTERLY', code, name });
            }

            // Annual period
            const annualStartDate = new Date(Date.UTC(year, startMonth, 1));
            const annualEndDate = new Date(Date.UTC(year + 1, startMonth, endDay, 23, 59, 59));
            if (annualEndDate < annualStartDate) {
              // Handle edge case where end day is before start day in the same month
              annualEndDate.setDate(0); // Last day of previous month
            }

            await tx.financialPeriod.create({
              data: {
                organizationId: ctx.actor.organizationId!,
                type: 'ANNUAL',
                status: 'OPEN',
                code: `${year}`,
                name: `FY ${year}`,
                startDate: annualStartDate,
                endDate: annualEndDate,
              },
            });

            created.push({ type: 'ANNUAL', code: `${year}`, name: `FY ${year}` });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'CONFIGURATION_CHANGES',
                entityType: 'FINANCIAL_PERIOD',
                entityId: `generate-fy-${year}`,
                entityLabel: `FY ${year} Period Generation`,
                description: `Generated financial periods for fiscal year ${year}: ${created.length} periods created`,
                changes: {
                  fiscalYear: { from: null, to: year },
                  monthlyCount: { from: null, to: 12 },
                  quarterlyCount: { from: null, to: 4 },
                  annualCount: { from: null, to: 1 },
                  periods: { from: null, to: created.map((p) => `${p.type}:${p.code}`).join(', ') },
                },
              },
              {
                organizationId: ctx.actor.organizationId!,
                ipAddress: net.ipAddress,
                userAgent: net.userAgent,
                requestId: reqId,
                sessionId: ctx.actor.sessionId ?? undefined,
              },
            );

            return { status: 201, body: { data: { fiscalYear: year, periodsCreated: created.length, periods: created } } };
          },
        ),
    });

    if (outcome.kind === 'REPLAYED') {
      return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    }

    return ok(outcome.result, 201, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}