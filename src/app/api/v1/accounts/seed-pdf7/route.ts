import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { runIdempotent } from '@/lib/api/idempotency';
import { withAudit } from '@/lib/db/with-audit';
import { writeAuditEntry } from '@/lib/audit/writer';
import { ValidationError } from '@/lib/kernel/errors';
import { CHART_OF_ACCOUNTS_PDF7, type AccountSeed } from '../../../../../../prisma/seed-data';

async function getAuditOptions(reqId: string, h: Headers) {
  return {
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
    userAgent: h.get('user-agent'),
    requestId: reqId,
  };
}

export async function POST(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'MASTER_DATA', action: 'CREATE' });

    const orgId = ctx.actor.organizationId!;
    if (!orgId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const key = request.headers.get('idempotency-key');
    if (!key) {
      return apiError(
        new ValidationError('An Idempotency-Key header is required on this endpoint.'),
        reqId,
      );
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: 'POST /api/v1/accounts/seed-pdf7',
      actorId: ctx.actor.userId,
      body: {},
      handler: async () =>
        withAudit(
          {
            organizationId: orgId,
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
            const accountsByCode = new Map<string, { id: string; code: string }>();
            let createdCount = 0;
            let updatedCount = 0;

            for (const acc of CHART_OF_ACCOUNTS_PDF7) {
              const parentId = acc.parentCode ? accountsByCode.get(acc.parentCode)?.id ?? null : null;
              const existing = await tx.account.findUnique({
                where: { organizationId_code: { organizationId: orgId, code: acc.code } },
                select: { id: true, code: true },
              });

              if (existing) {
                await tx.account.update({
                  where: { id: existing.id },
                  data: {
                    name: acc.name,
                    description: acc.description ?? undefined,
                    type: acc.type,
                    subCategory: acc.subCategory as import('@/generated/prisma/client').AccountSubCategory | null,
                    normalBalance: acc.normalBalance,
                    parentId,
                    isPostable: acc.isPostable ?? true,
                    isReconcilable: acc.isReconcilable ?? false,
                    requiresDocument: acc.requiresDocument ?? false,
                    status: (acc as AccountSeed & { status?: string }).status ?? 'ACTIVE',
                  },
                });
                accountsByCode.set(acc.code, { id: existing.id, code: acc.code });
                updatedCount++;
              } else {
                const created = await tx.account.create({
                  data: {
                    organizationId: orgId,
                    code: acc.code,
                    name: acc.name,
                    description: acc.description ?? undefined,
                    type: acc.type,
                    subCategory: acc.subCategory as import('@/generated/prisma/client').AccountSubCategory | null,
                    normalBalance: acc.normalBalance,
                    parentId,
                    isPostable: acc.isPostable ?? true,
                    isReconcilable: acc.isReconcilable ?? false,
                    requiresDocument: acc.requiresDocument ?? false,
                    status: (acc as AccountSeed & { status?: string }).status ?? 'ACTIVE',
                  },
                  select: { id: true, code: true },
                });
                accountsByCode.set(acc.code, created);
                createdCount++;
              }
            }

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'CONFIGURATION_CHANGES',
                entityType: 'ACCOUNT',
                entityId: 'seed-pdf7',
                entityLabel: 'CHART_OF_ACCOUNTS_PDF7',
                description: `Seeded PDF §7 Chart of Accounts: ${createdCount} created, ${updatedCount} updated`,
                changes: {
                  totalAccounts: { from: null, to: CHART_OF_ACCOUNTS_PDF7.length },
                  created: { from: null, to: createdCount },
                  updated: { from: null, to: updatedCount },
                },
              },
              {
                organizationId: orgId,
                ipAddress: net.ipAddress,
                userAgent: net.userAgent,
                requestId: reqId,
                sessionId: ctx.actor.sessionId,
              },
            );

            return { status: 201, body: { data: { created: createdCount, updated: updatedCount, total: CHART_OF_ACCOUNTS_PDF7.length } } };
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