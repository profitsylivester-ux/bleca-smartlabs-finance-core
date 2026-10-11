import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { createHash } from 'crypto';
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

function parseDate(value: string, format: string): Date | null {
  if (!value) return null;
  try {
    const fmt = format
      .replace('yyyy', 'YYYY')
      .replace('yy', 'YY')
      .replace('MM', 'MM')
      .replace('dd', 'DD');
    const parts = fmt.split(/[-/]/);
    const valParts = value.split(/[-/]/);
    if (parts.length !== 3 || valParts.length !== 3) return null;

    const yearIdx = parts.findIndex(p => p.startsWith('Y'));
    const monthIdx = parts.findIndex(p => p.startsWith('M'));
    const dayIdx = parts.findIndex(p => p.startsWith('D'));

    if (yearIdx === -1 || monthIdx === -1 || dayIdx === -1) return null;
    const year = parseInt(valParts[yearIdx] ?? '', 10);
    const month = parseInt(valParts[monthIdx] ?? '', 10) - 1;
    const day = parseInt(valParts[dayIdx] ?? '', 10);

    if (isNaN(year) || isNaN(month) || isNaN(day)) return null;
    const date = new Date(Date.UTC(year, month, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) {
      return null;
    }
    return date;
  } catch {
    return null;
  }
}

function parseAmount(value: string, convention: string, decimalSep: string, thousandSep: string): { debit: number; credit: number } | null {
  if (!value) return { debit: 0, credit: 0 };
  try {
    const cleaned = value.replace(new RegExp(`\\${thousandSep}`, 'g'), '').replace(decimalSep, '.');
    const num = parseFloat(cleaned);
    if (isNaN(num)) return null;

    switch (convention) {
      case 'SINGLE_DEBIT_CREDIT':
        return { debit: num > 0 ? num : 0, credit: num < 0 ? -num : 0 };
      case 'SEPARATE_DEBIT_CREDIT':
        return { debit: Math.max(0, num), credit: Math.max(0, -num) };
      case 'SIGNED_SINGLE':
        return { debit: num > 0 ? num : 0, credit: num < 0 ? -num : 0 };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function generateFingerprint(normalized: Record<string, unknown>): string {
  const str = JSON.stringify(normalized, Object.keys(normalized).sort());
  return createHash('sha256').update(str).digest('hex').substring(0, 32);
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

    if (batch.status !== 'MAPPING') {
      return apiError(new ValidationError(`Cannot validate in ${batch.status} status. Complete mapping first.`), reqId);
    }

    if (batch.fieldMappings.length === 0) {
      return apiError(new ValidationError('No field mapping defined for this batch'), reqId);
    }

    const mapping = batch.fieldMappings[0]!;
    const columnMap = mapping.columnMap as Record<string, number>;

    const rows = await prisma.importRow.findMany({
      where: { batchId: id, status: 'PENDING' },
      orderBy: { rowNumber: 'asc' },
      select: { id: true, rowNumber: true, rawData: true, status: true },
    });

    if (rows.length === 0) {
      return apiError(new ValidationError('No pending rows to validate'), reqId);
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: `POST /api/v1/imports/${id}/validate`,
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
            let validCount = 0;
            let errorCount = 0;

            for (const row of rows) {
              const raw = row.rawData as string[];
              const mapped: Record<string, unknown> = {};
              const errors: Array<{ type: string; field: string; originalValue: unknown; message: string }> = [];

              const dateCol = columnMap.date;
              const descCol = columnMap.description;
              const refCol = columnMap.reference;
              const debitCol = columnMap.debit;
              const creditCol = columnMap.credit;
              const amountCol = columnMap.amount;

              let dateVal: Date | null = null;
              if (dateCol !== undefined && raw[dateCol]) {
                dateVal = parseDate(raw[dateCol], mapping.dateFormat);
                if (!dateVal) {
                  errors.push({
                    type: 'VALIDATION',
                    field: 'date',
                    originalValue: raw[dateCol],
                    message: `Invalid date format. Expected ${mapping.dateFormat}`,
                  });
                }
                mapped.date = dateVal?.toISOString().split('T')[0] ?? null;
              }

              mapped.description = descCol !== undefined ? raw[descCol] ?? '' : '';
              mapped.reference = refCol !== undefined ? raw[refCol] ?? null : null;

              let amounts: { debit: number; credit: number } | null = null;
              if (mapping.amountConvention === 'SEPARATE_DEBIT_CREDIT') {
                if (debitCol !== undefined && raw[debitCol]) {
                  const parsed = parseAmount(raw[debitCol], 'SINGLE_DEBIT_CREDIT', mapping.decimalSeparator, mapping.thousandSeparator);
                  if (parsed) amounts = { debit: parsed.debit, credit: 0 };
                  else errors.push({ type: 'VALIDATION', field: 'debit', originalValue: raw[debitCol], message: 'Invalid debit amount' });
                }
                if (creditCol !== undefined && raw[creditCol]) {
                  const parsed = parseAmount(raw[creditCol], 'SINGLE_DEBIT_CREDIT', mapping.decimalSeparator, mapping.thousandSeparator);
                  if (parsed) amounts = { ...(amounts || { debit: 0, credit: 0 }), credit: parsed.credit };
                  else errors.push({ type: 'VALIDATION', field: 'credit', originalValue: raw[creditCol], message: 'Invalid credit amount' });
                }
              } else if (amountCol !== undefined && raw[amountCol]) {
                amounts = parseAmount(raw[amountCol], mapping.amountConvention, mapping.decimalSeparator, mapping.thousandSeparator);
                if (!amounts) {
                  errors.push({ type: 'VALIDATION', field: 'amount', originalValue: raw[amountCol], message: 'Invalid amount' });
                }
              }

              if (amounts) {
                mapped.debit = amounts.debit;
                mapped.credit = amounts.credit;
              } else if (errors.length === 0) {
                errors.push({ type: 'VALIDATION', field: 'amount', originalValue: null, message: 'No amount columns mapped or provided' });
              }

              const fingerprint = generateFingerprint(mapped);
              mapped.fingerprint = fingerprint;
              const mappedJson = mapped as import('@/generated/prisma/client').InputJsonValue;
              const normalizedJson = mapped as import('@/generated/prisma/client').InputJsonValue;
              const orgId = ctx.actor.organizationId!;

              const duplicateInFile = await tx.importRow.findFirst({
                where: { batchId: id, fingerprint, id: { not: row.id } },
                select: { id: true },
              });
              const duplicateInHistory = await tx.importRow.findFirst({
                where: { fingerprint, batchId: { not: id }, batch: { organizationId: orgId } },
                select: { id: true },
              });
              const ref = mapped.reference as string | null;
              const dateValStr = dateVal?.toISOString().split('T')[0] ?? null;
              const amountVal = amounts?.debit ? amounts.debit : amounts?.credit ? amounts.credit : null;
              const duplicateInTransactions = await prisma.transaction.findFirst({
                where: {
                  organizationId: orgId,
                  ...(ref ? { reference: ref } : {}),
                  ...(dateValStr ? { date: dateValStr } : {}),
                  ...(amountVal !== null ? { amount: amountVal } : {}),
                },
                select: { id: true },
              });

              const isDuplicate = !!(duplicateInFile || duplicateInHistory || duplicateInTransactions);

              if (errors.length > 0) {
                errorCount++;
                await tx.importRow.update({
                  where: { id: row.id },
                  data: { status: 'ERROR', mappedData: mappedJson, normalizedData: normalizedJson, fingerprint },
                });

                for (const err of errors) {
                  await tx.importError.create({
                    data: {
                      batchId: id,
                      rowId: row.id,
                      rowNumber: row.rowNumber,
                      type: err.type as ImportErrorType,
                      field: err.field,
                      originalValue: err.originalValue as import('@/generated/prisma/client').InputJsonValue,
                      message: err.message,
                      severity: 'ERROR',
                    },
                  });
                }
              } else if (isDuplicate) {
                errorCount++;
                await tx.importRow.update({
                  where: { id: row.id },
                  data: { status: 'DUPLICATE', mappedData: mappedJson, normalizedData: normalizedJson, fingerprint },
                });
                await tx.importError.create({
                  data: {
                    batchId: id,
                    rowId: row.id,
                    rowNumber: row.rowNumber,
                    type: 'DUPLICATE',
                    field: 'fingerprint',
                    originalValue: fingerprint,
                    message: 'Duplicate transaction detected',
                    severity: 'ERROR',
                  },
                });
              } else {
                validCount++;
                await tx.importRow.update({
                  where: { id: row.id },
                  data: { status: 'VALID', mappedData: mappedJson, normalizedData: normalizedJson, fingerprint },
                });
              }
            }

            await tx.importBatch.update({
              where: { id },
              data: {
                status: 'VALIDATING',
                validatedById: ctx.actor.userId,
                validRows: validCount,
                errorRows: errorCount,
                duplicateRows: rows.filter(r => r.status === 'DUPLICATE').length,
              },
            });

            const errorSummary = await tx.importError.groupBy({
              by: ['type'],
              where: { batchId: id },
              _count: true,
            });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'IMPORT_VALIDATED',
                entityType: 'IMPORT_BATCH',
                entityId: batch.id,
                entityLabel: batch.code,
                description: `Validated import ${batch.code}: ${validCount} valid, ${errorCount} errors`,
                changes: {
                  status: { from: 'MAPPING', to: 'VALIDATING' },
                  validRows: { from: 0, to: validCount },
                  errorRows: { from: 0, to: errorCount },
                  errorSummary: { from: null, to: errorSummary },
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

            return { status: 200, body: { data: { validCount, errorCount, totalRows: rows.length } } };
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