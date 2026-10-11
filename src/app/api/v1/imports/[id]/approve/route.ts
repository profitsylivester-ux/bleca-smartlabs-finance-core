import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { runIdempotent } from '@/lib/api/idempotency';
import { withAudit } from '@/lib/db/with-audit';
import { writeAuditEntry } from '@/lib/audit/writer';
import { ValidationError, NotFoundError } from '@/lib/kernel/errors';

async function getAuditOptions(reqId: string, h: Headers) {
  return {
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
    userAgent: h.get('user-agent'),
    requestId: reqId,
  };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'STATEMENT_IMPORT', action: 'APPROVE' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const key = request.headers.get('idempotency-key');
    if (!key) {
      return apiError(new ValidationError('An Idempotency-Key header is required on this endpoint.'), reqId);
    }

    const { id } = await params;

    const batch = await prisma.importBatch.findFirst({
      where: { id, organizationId: ctx.actor.organizationId },
      select: {
        id: true,
        code: true,
        status: true,
        errorRows: true,
        duplicateRows: true,
        validRows: true,
      },
    });

    if (!batch) {
      return apiError(new NotFoundError('Import batch', id), reqId);
    }

    if (batch.status !== 'PREVIEW' && batch.status !== 'AWAITING_APPROVAL') {
      return apiError(new ValidationError(`Cannot approve in ${batch.status} status. Complete duplicate detection first.`), reqId);
    }

    const errorCount = await prisma.importError.count({
      where: { batchId: id, resolved: false, severity: 'ERROR' },
    });

    if (errorCount > 0) {
      return apiError(new ValidationError(`Cannot approve: ${errorCount} unresolved errors remain. Resolve all errors first.`), reqId);
    }

    if (batch.duplicateRows > 0) {
      const unresolvedDuplicates = await prisma.importError.count({
        where: { batchId: id, type: 'DUPLICATE', resolved: false },
      });
      if (unresolvedDuplicates > 0) {
        return apiError(new ValidationError(`Cannot approve: ${unresolvedDuplicates} duplicate rows require resolution. Mark as skipped or resolve first.`), reqId);
      }
    }

    if (batch.validRows === 0) {
      return apiError(new ValidationError('Cannot approve: no valid rows to import'), reqId);
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: `POST /api/v1/imports/${id}/approve`,
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
            const updatedBatch = await tx.importBatch.update({
              where: { id },
              data: {
                status: 'APPROVED',
                approvedById: ctx.actor.userId,
                approvedAt: new Date(),
              },
              select: { id: true, code: true, status: true, approvedAt: true },
            });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'IMPORT_APPROVED',
                entityType: 'IMPORT_BATCH',
                entityId: batch.id,
                entityLabel: batch.code,
                description: `Approved import ${batch.code} for commit: ${batch.validRows} valid rows`,
                changes: {
                  status: { from: batch.status, to: 'APPROVED' },
                  approvedById: { from: null, to: ctx.actor.userId },
                  approvedAt: { from: null, to: new Date().toISOString() },
                },
              },
              {
                organizationId: ctx.actor.organizationId,
                ipAddress: net.ipAddress,
                userAgent: net.userAgent,
                requestId: reqId,
                sessionId: ctx.actor.sessionId,
              },
            );

            return { status: 200, body: { data: updatedBatch } };
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