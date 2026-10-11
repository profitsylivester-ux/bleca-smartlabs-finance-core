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
import { ValidationError, NotFoundError } from '@/lib/kernel/errors';

const mappingSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  dateFormat: z.string().min(1),
  amountConvention: z.enum(['SINGLE_DEBIT_CREDIT', 'SEPARATE_DEBIT_CREDIT', 'SIGNED_SINGLE']),
  decimalSeparator: z.string().max(1).default('.'),
  thousandSeparator: z.string().max(1).default(','),
  encoding: z.string().default('UTF-8'),
  hasHeader: z.boolean().default(true),
  columnMap: z.record(z.string(), z.number().int().nonnegative()),
});

async function getAuditOptions(reqId: string, h: Headers) {
  return {
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
    userAgent: h.get('user-agent'),
    requestId: reqId,
  };
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
      select: { id: true, source: true },
    });
    if (!batch) {
      return apiError(new NotFoundError('Import batch', id), reqId);
    }

    const mappings = await prisma.importFieldMapping.findMany({
      where: {
        organizationId: ctx.actor.organizationId,
        source: batch.source,
        OR: [{ batchId: id }, { batchId: null, isDefault: true }],
      },
      select: {
        id: true,
        batchId: true,
        source: true,
        name: true,
        description: true,
        dateFormat: true,
        amountConvention: true,
        decimalSeparator: true,
        thousandSeparator: true,
        encoding: true,
        hasHeader: true,
        columnMap: true,
        isDefault: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });

    return ok({ data: mappings }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
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
    const body = mappingSchema.parse(await request.json());

    const batch = await prisma.importBatch.findFirst({
      where: { id, organizationId: ctx.actor.organizationId },
      select: { id: true, code: true, status: true, source: true },
    });
    if (!batch) {
      return apiError(new NotFoundError('Import batch', id), reqId);
    }

    if (!['UPLOADED', 'MAPPING'].includes(batch.status)) {
      return apiError(new ValidationError(`Cannot add mapping in ${batch.status} status`), reqId);
    }

    const existingDefault = await prisma.importFieldMapping.findFirst({
      where: { organizationId: ctx.actor.organizationId, source: batch.source, name: body.name },
      select: { id: true },
    });
    if (existingDefault) {
      return apiError(new ValidationError('A mapping with this name already exists for this source'), reqId);
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: `POST /api/v1/imports/${id}/mapping`,
      actorId: ctx.actor.userId,
      body,
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
            const mapping = await tx.importFieldMapping.create({
              data: {
                organizationId: ctx.actor.organizationId!,
                batchId: id,
                source: batch.source,
                name: body.name,
                description: body.description,
                dateFormat: body.dateFormat,
                amountConvention: body.amountConvention,
                decimalSeparator: body.decimalSeparator,
                thousandSeparator: body.thousandSeparator,
                encoding: body.encoding,
                hasHeader: body.hasHeader,
                columnMap: body.columnMap as import('@/generated/prisma/client').InputJsonValue,
                createdById: ctx.actor.userId,
              },
              select: {
                id: true,
                batchId: true,
                source: true,
                name: true,
                description: true,
                dateFormat: true,
                amountConvention: true,
                decimalSeparator: true,
                thousandSeparator: true,
                encoding: true,
                hasHeader: true,
                columnMap: true,
                isDefault: true,
                createdAt: true,
                updatedAt: true,
              },
            });

            await tx.importBatch.update({
              where: { id },
              data: { status: 'MAPPING', mappedById: ctx.actor.userId },
            });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'IMPORT_MAPPING_SAVED',
                entityType: 'IMPORT_FIELD_MAPPING',
                entityId: mapping.id,
                entityLabel: mapping.name,
                description: `Saved field mapping ${mapping.name} for import ${batch.code}`,
                changes: {
                  name: { from: null, to: mapping.name },
                  dateFormat: { from: null, to: mapping.dateFormat },
                  amountConvention: { from: null, to: mapping.amountConvention },
                  columnMap: { from: null, to: mapping.columnMap },
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

            return { status: 201, body: { data: mapping } };
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