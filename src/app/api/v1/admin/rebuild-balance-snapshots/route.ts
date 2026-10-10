import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { runIdempotent } from '@/lib/api/idempotency';
import { withAudit } from '@/lib/db/with-audit';
import { writeAuditEntry } from '@/lib/audit/writer';

export async function POST(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'BACKUP_ADMIN', action: 'ADMINISTER' });

    if (!ctx.actor.organizationId) {
      return apiError(new Error('No organization context'), reqId);
    }

    const key = request.headers.get('idempotency-key');
    if (!key) {
      return apiError(
        new Error('An Idempotency-Key header is required on this endpoint.'),
        reqId,
      );
    }

    const h = await headers();
    const net = {
      ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
      userAgent: h.get('user-agent'),
      requestId: reqId,
    };

    const outcome = await runIdempotent({
      key,
      scope: 'POST /api/v1/admin/rebuild-balance-snapshots',
      actorId: ctx.actor.userId,
      body: {},
      handler: async () =>
        withAudit(
          {
            organizationId: ctx.actor.organizationId,
            actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
            ipAddress: net.ipAddress,
            userAgent: net.userAgent,
            requestId: reqId,
            sessionId: ctx.actor.sessionId,
          },
          async (tx) => {
            await tx.accountBalanceSnapshot.deleteMany({
              where: { organizationId: ctx.actor.organizationId ?? undefined },
            });

            const accounts = await tx.account.findMany({
              where: { organizationId: ctx.actor.organizationId ?? undefined, isPostable: true },
              select: { id: true },
            });

            const periods = await tx.financialPeriod.findMany({
              where: { organizationId: ctx.actor.organizationId ?? undefined },
              select: { id: true },
            });

            const currencies = await tx.currency.findMany({
              where: { isActive: true },
              select: { code: true },
            });

            let snapshotsCreated = 0;

            for (const account of accounts) {
              for (const period of periods) {
                for (const currency of currencies) {
                  const entryWhere: Prisma.JournalEntryWhereInput = {
                    organizationId: ctx.actor.organizationId ?? undefined,
                    periodId: period.id,
                    status: { in: ['POSTED', 'LOCKED'] },
                  };

                  const where: Prisma.JournalLineWhereInput = {
                    organizationId: ctx.actor.organizationId ?? undefined,
                    accountId: account.id,
                    currencyCode: currency.code,
                    entry: entryWhere,
                  };

                  const lines = await tx.journalLine.findMany({
                    where,
                    select: { debit: true, credit: true },
                  });

                  const debitTotal = lines.reduce((sum, l) => sum + Number(l.debit), 0);
                  const creditTotal = lines.reduce((sum, l) => sum + Number(l.credit), 0);
                  const balance = debitTotal - creditTotal;

                  if (debitTotal !== 0 || creditTotal !== 0) {
                    await tx.accountBalanceSnapshot.upsert({
                      where: {
                        accountId_periodId_currencyCode: {
                          accountId: account.id,
                          periodId: period.id,
                          currencyCode: currency.code,
                        },
                      },
                      create: {
                        organizationId: ctx.actor.organizationId!,
                        accountId: account.id,
                        periodId: period.id,
                        currencyCode: currency.code,
                        debitTotal,
                        creditTotal,
                        balance,
                      },
                      update: {
                        debitTotal,
                        creditTotal,
                        balance,
                        computedAt: new Date(),
                      },
                    });
                    snapshotsCreated++;
                  }
                }
              }
            }

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'CONFIGURATION_CHANGES',
                entityType: 'ACCOUNT_BALANCE_SNAPSHOT',
                entityId: ctx.actor.organizationId ?? undefined,
                entityLabel: 'balance_snapshots_rebuild',
                description: `Rebuilt ${snapshotsCreated} account balance snapshots`,
                changes: { snapshotsCreated: { from: null, to: snapshotsCreated } },
              },
              {
                organizationId: ctx.actor.organizationId ?? undefined,
                ipAddress: net.ipAddress,
                userAgent: net.userAgent,
                requestId: reqId,
                sessionId: ctx.actor.sessionId,
              },
            );

            return { status: 200, body: { data: { snapshotsCreated, message: 'Balance snapshots rebuilt successfully' } } };
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