import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { runIdempotent } from '@/lib/api/idempotency';
import { withAudit } from '@/lib/db/with-audit';
import { writeAuditEntry } from '@/lib/audit/writer';
import { runBackup } from '@/lib/backup/service';
import { ValidationError } from '@/lib/kernel/errors';
import type { AuditAction, AuditEntityType } from '@/generated/prisma/client';

const runSchema = z.object({
  type: z.enum(['FULL', 'INCREMENTAL', 'POINT_IN_TIME']).default('FULL'),
});

export async function POST(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'BACKUP_ADMIN', action: 'CREATE' });

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

    const body = runSchema.parse(await request.json());

    const h = await headers();
    const net = {
      ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
      userAgent: h.get('user-agent'),
      requestId: reqId,
      sessionId: ctx.actor.sessionId,
    };

    const outcome = await runIdempotent({
      key,
      scope: 'POST /api/v1/backups/run',
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
            sessionId: ctx.actor.sessionId,
          },
          async (tx) => {
            const result = await runBackup(ctx.actor.organizationId!, body.type, ctx.actor.userId);

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'BACKUP_VERIFIED',
                entityType: 'BACKUP_RUN',
                entityId: result.id,
                entityLabel: `${body.type} backup`,
                description: `Initiated ${body.type} backup`,
                changes: {
                  type: { from: null, to: body.type },
                  storageKey: { from: null, to: result.storageKey },
                },
              },
              { organizationId: ctx.actor.organizationId!, ipAddress: net.ipAddress, userAgent: net.userAgent, requestId: reqId, sessionId: ctx.actor.sessionId }
            );

            return { status: 201, body: { data: result } };
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