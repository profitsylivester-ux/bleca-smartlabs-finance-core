import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { runIdempotent } from '@/lib/api/idempotency';
import { withAudit } from '@/lib/db/with-audit';
import { writeAuditEntry } from '@/lib/audit/writer';
import { testRestore } from '@/lib/backup/service';
import { NotFoundError, ValidationError } from '@/lib/kernel/errors';
import type { AuditAction, AuditEntityType } from '@/generated/prisma/client';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'BACKUP_ADMIN', action: 'APPROVE' }); // Restore test requires approval-level permission

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const { id } = await params;

    const key = request.headers.get('idempotency-key');
    if (!key) {
      return apiError(
        new ValidationError('An Idempotency-Key header is required on this endpoint.'),
        reqId,
      );
    }

    const backupRun = await prisma.backupRun.findUnique({
      where: { id },
      select: { id: true, organizationId: true, storageKey: true, status: true, auditChainHead: true },
    });

    if (!backupRun || backupRun.organizationId !== ctx.actor.organizationId) {
      return apiError(new NotFoundError('Backup run', id), reqId);
    }

    const h = await headers();
    const net = {
      ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
      userAgent: h.get('user-agent'),
      requestId: reqId,
      sessionId: ctx.actor.sessionId,
    };

    const outcome = await runIdempotent({
      key,
      scope: `POST /api/v1/backups/${id}/restore-test`,
      actorId: ctx.actor.userId,
      body: {},
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
            sessionId: ctx.actor.sessionId,
          },
          async (tx) => {
            const result = await testRestore(id, ctx.actor.userId);

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'RESTORE_TEST',
                entityType: 'BACKUP_RUN',
                entityId: id,
                entityLabel: backupRun.storageKey,
                description: `Restore test completed - tables match: ${result.tableCountsMatch}, audit chain matches: ${result.auditChainMatches}`,
                result: 'SUCCESS',
                metadata: JSON.parse(JSON.stringify(result)),
              },
              { organizationId: ctx.actor.organizationId!, ipAddress: net.ipAddress, userAgent: net.userAgent, requestId: reqId, sessionId: ctx.actor.sessionId }
            );

            return { status: 200, body: { data: result } };
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

