import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
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

interface PreviewRow {
  rowNumber: number;
  date: string | null;
  description: string;
  reference: string | null;
  debit: number;
  credit: number;
  fingerprint: string;
  status: string;
  errors: Array<{
    field: string;
    message: string;
    originalValue: unknown;
  }>;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'STATEMENT_IMPORT', action: 'VIEW' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const { id } = await params;

    const batch = await prisma.importBatch.findFirst({
      where: { id, organizationId: ctx.actor.organizationId },
      include: {
        fieldMappings: { where: { batchId: id }, orderBy: { createdAt: 'desc' }, take: 1 },
        rows: {
          where: { status: { in: ['VALID', 'DUPLICATE', 'ERROR'] } },
          orderBy: { rowNumber: 'asc' },
          select: {
            id: true,
            rowNumber: true,
            rawData: true,
            mappedData: true,
            normalizedData: true,
            status: true,
            fingerprint: true,
            importedTransactionId: true,
            errors: {
              select: {
                field: true,
                message: true,
                originalValue: true,
                type: true,
              },
            },
          },
        },
      },
    });

    if (!batch) {
      return apiError(new NotFoundError('Import batch', id), reqId);
    }

    if (!['VALIDATING', 'PREVIEW', 'AWAITING_APPROVAL', 'APPROVED', 'IMPORTING', 'COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'ROLLED_BACK'].includes(batch.status)) {
      return apiError(new ValidationError(`Preview not available in ${batch.status} status. Complete validation first.`), reqId);
    }

    if (batch.fieldMappings.length === 0) {
      return apiError(new ValidationError('No field mapping defined for this batch'), reqId);
    }

    const mapping = batch.fieldMappings[0]!;
    const columnMap = mapping.columnMap as Record<string, number>;

    const previewRows: PreviewRow[] = [];
    let validCount = 0;
    let duplicateCount = 0;
    let errorCount = 0;

    for (const row of batch.rows) {
      const normalized = row.normalizedData as Record<string, unknown> | null;
      const mapped = row.mappedData as Record<string, unknown> | null;

      const previewRow: PreviewRow = {
        rowNumber: row.rowNumber,
        date: (normalized?.date as string) ?? (mapped?.date as string) ?? null,
        description: (normalized?.description as string) ?? (mapped?.description as string) ?? '',
        reference: (normalized?.reference as string) ?? (mapped?.reference as string) ?? null,
        debit: Number(normalized?.debit ?? mapped?.debit ?? 0),
        credit: Number(normalized?.credit ?? mapped?.credit ?? 0),
        fingerprint: row.fingerprint ?? '',
        status: row.status,
        errors: row.errors.map(e => ({
          field: e.field ?? '',
          message: e.message,
          originalValue: e.originalValue,
        })),
      };

      previewRows.push(previewRow);

      if (row.status === 'VALID') validCount++;
      else if (row.status === 'DUPLICATE') duplicateCount++;
      else if (row.status === 'ERROR') errorCount++;
    }

    const summary = {
      totalRows: batch.rows.length,
      validRows: validCount,
      duplicateRows: duplicateCount,
      errorRows: errorCount,
      totalDebit: previewRows.reduce((sum, r) => sum + r.debit, 0),
      totalCredit: previewRows.reduce((sum, r) => sum + r.credit, 0),
    };

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    await withAudit(
      {
        organizationId: ctx.actor.organizationId,
        actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
        ipAddress: net.ipAddress,
        userAgent: net.userAgent,
        requestId: reqId,
        sessionId: ctx.actor.sessionId,
      },
      async () => {},
      {
        action: 'IMPORT_VALIDATED',
        entityType: 'IMPORT_BATCH',
        entityId: batch.id,
        entityLabel: batch.code,
        description: `Viewed preview for import ${batch.code}`,
        changes: {},
      },
    );

    return ok({ data: { batch: { id: batch.id, code: batch.code, status: batch.status }, rows: previewRows, summary } }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}