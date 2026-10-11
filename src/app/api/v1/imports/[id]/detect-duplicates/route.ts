import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { createHash } from 'crypto';
import { prisma, ImportErrorType } from '@/lib/db/prisma';
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

function generateFingerprint(normalized: Record<string, unknown>): string {
  const str = JSON.stringify(normalized, Object.keys(normalized).sort());
  return createHash('sha256').update(str).digest('hex').substring(0, 32);
}

interface DetectDuplicatesResult {
  rowNumber: number;
  fingerprint: string;
  isDuplicate: boolean;
  duplicateType: 'WITHIN_FILE' | 'PRIOR_IMPORT' | 'EXISTING_TRANSACTION' | 'NONE';
  matchedImportRowId?: string;
  matchedTransactionId?: string;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'STATEMENT_IMPORT', action: 'EDIT' });

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
      include: {
        fieldMappings: { where: { batchId: id }, orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });

    if (!batch) {
      return apiError(new NotFoundError('Import batch', id), reqId);
    }

    if (batch.status !== 'VALIDATING' && batch.status !== 'PREVIEW') {
      return apiError(new ValidationError(`Cannot detect duplicates in ${batch.status} status. Complete validation first.`), reqId);
    }

    if (batch.fieldMappings.length === 0) {
      return apiError(new ValidationError('No field mapping defined for this batch'), reqId);
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: `POST /api/v1/imports/${id}/detect-duplicates`,
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
            const rows = await tx.importRow.findMany({
              where: { batchId: id, status: { in: ['VALID', 'DUPLICATE'] } },
              orderBy: { rowNumber: 'asc' },
              select: { id: true, rowNumber: true, normalizedData: true, fingerprint: true, status: true },
            });

            if (rows.length === 0) {
              return { status: 200, body: { data: { results: [], summary: { totalChecked: 0, duplicatesFound: 0, withinFile: 0, priorImports: 0, existingTransactions: 0 } } } };
            }

            const orgId = ctx.actor.organizationId!;
            const results: DetectDuplicatesResult[] = [];
            let duplicateCount = 0;
            let withinFileCount = 0;
            let priorImportCount = 0;
            let existingTransactionCount = 0;

            const seenFingerprints = new Map<string, string>();

            for (const row of rows) {
              const normalized = row.normalizedData as Record<string, unknown> | null;
              const fingerprint = row.fingerprint ?? (normalized ? generateFingerprint(normalized) : '');

              let isDuplicate = false;
              let duplicateType: DetectDuplicatesResult['duplicateType'] = 'NONE';
              let matchedImportRowId: string | undefined;
              let matchedTransactionId: string | undefined;

              if (fingerprint) {
                if (seenFingerprints.has(fingerprint)) {
                  isDuplicate = true;
                  duplicateType = 'WITHIN_FILE';
                  matchedImportRowId = seenFingerprints.get(fingerprint);
                  withinFileCount++;
                } else {
                  seenFingerprints.set(fingerprint, row.id);
                }
              }

              if (!isDuplicate && fingerprint) {
                const priorImport = await tx.importRow.findFirst({
                  where: { fingerprint, batchId: { not: id }, batch: { organizationId: orgId }, status: { in: ['VALID', 'IMPORTED'] } },
                  select: { id: true },
                });

                if (priorImport) {
                  isDuplicate = true;
                  duplicateType = 'PRIOR_IMPORT';
                  matchedImportRowId = priorImport.id;
                  priorImportCount++;
                }
              }

              if (!isDuplicate && normalized) {
                const ref = normalized.reference as string | null;
                const dateVal = normalized.date as string | null;
                const amountVal = Number(normalized.debit ?? normalized.credit ?? 0);

                if (ref && dateVal && amountVal > 0) {
                  const existingTx = await tx.transaction.findFirst({
                    where: {
                      organizationId: orgId,
                      reference: ref,
                      date: new Date(dateVal),
                      amount: amountVal,
                    },
                    select: { id: true },
                  });

                  if (existingTx) {
                    isDuplicate = true;
                    duplicateType = 'EXISTING_TRANSACTION';
                    matchedTransactionId = existingTx.id;
                    existingTransactionCount++;
                  }
                }
              }

              if (isDuplicate) {
                duplicateCount++;
                if (row.status !== 'DUPLICATE') {
                  await tx.importRow.update({
                    where: { id: row.id },
                    data: { status: 'DUPLICATE' },
                  });

                  await tx.importError.create({
                    data: {
                      batchId: id,
                      rowId: row.id,
                      rowNumber: row.rowNumber,
                      type: 'DUPLICATE',
                      field: 'fingerprint',
                      originalValue: fingerprint,
                      message: `Duplicate transaction detected (${duplicateType.replace('_', ' ').toLowerCase()})`,
                      severity: 'ERROR',
                    },
                  });
                }
              }

              results.push({
                rowNumber: row.rowNumber,
                fingerprint,
                isDuplicate,
                duplicateType,
                matchedImportRowId,
                matchedTransactionId,
              });
            }

            await tx.importBatch.update({
              where: { id },
              data: {
                status: 'PREVIEW',
                duplicateRows: duplicateCount,
              },
            });

            const summary = {
              totalChecked: rows.length,
              duplicatesFound: duplicateCount,
              withinFile: withinFileCount,
              priorImports: priorImportCount,
              existingTransactions: existingTransactionCount,
            };

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'IMPORT_DUPLICATES_DETECTED',
                entityType: 'IMPORT_BATCH',
                entityId: batch.id,
                entityLabel: batch.code,
                description: `Detected duplicates for import ${batch.code}: ${duplicateCount} duplicates found`,
                changes: {
                  status: { from: batch.status, to: 'PREVIEW' },
                  duplicateRows: { from: batch.duplicateRows, to: duplicateCount },
                  duplicateSummary: { from: null, to: summary },
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

            return { status: 200, body: { data: { results, summary } } };
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