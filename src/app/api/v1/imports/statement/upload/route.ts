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
import { ValidationError, ConflictError } from '@/lib/kernel/errors';
import { createHash } from 'crypto';

const uploadSchema = z.object({
  fileName: z.string().min(1),
  fileSize: z.number().positive(),
  mimeType: z.string().min(1),
  source: z.enum(['EXCEL', 'CSV', 'API', 'MANUAL']),
  fileHash: z.string().length(64), // SHA256 hex
});

async function getAuditOptions(reqId: string, h: Headers) {
  return {
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
    userAgent: h.get('user-agent'),
    requestId: reqId,
  };
}

function verifyFileHash(fileBuffer: Buffer, expectedHash: string): boolean {
  const hash = createHash('sha256').update(fileBuffer).digest('hex');
  return hash === expectedHash;
}

export async function POST(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'STATEMENT_IMPORT', action: 'CREATE' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const fileName = formData.get('fileName') as string | null;
    const fileSize = formData.get('fileSize') as string | null;
    const mimeType = formData.get('mimeType') as string | null;
    const source = formData.get('source') as string | null;
    const fileHash = formData.get('fileHash') as string | null;

    if (!file || !fileName || !fileSize || !mimeType || !source || !fileHash) {
      return apiError(new ValidationError('Missing required fields: file, fileName, fileSize, mimeType, source, fileHash'), reqId);
    }

    const size = parseInt(fileSize, 10);
    if (isNaN(size) || size <= 0) {
      return apiError(new ValidationError('Invalid fileSize'), reqId);
    }

    const body = uploadSchema.parse({
      fileName,
      fileSize: size,
      mimeType,
      source,
      fileHash,
    });

    const fileBuffer = Buffer.from(await file.arrayBuffer());

    if (!verifyFileHash(fileBuffer, body.fileHash)) {
      return apiError(new ValidationError('File hash does not match'), reqId);
    }

    const existing = await prisma.importBatch.findUnique({
      where: { organizationId_fileHash: { organizationId: ctx.actor.organizationId, fileHash: body.fileHash } },
      select: { id: true, code: true, status: true },
    });
    if (existing) {
      return apiError(new ConflictError(`File with this hash already imported as ${existing.code}`), reqId);
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key: body.fileHash,
      scope: 'POST /api/v1/imports/statement/upload',
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
            const orgId = ctx.actor.organizationId!;
            const count = await tx.importBatch.count({ where: { organizationId: orgId } });
            const code = `IMP-${new Date().getFullYear()}-${String(count + 1).padStart(3, '0')}`;

            const batch = await tx.importBatch.create({
              data: {
                organizationId: orgId,
                code,
                source: body.source,
                fileName: body.fileName,
                fileHash: body.fileHash,
                fileSize: body.fileSize,
                mimeType: body.mimeType,
                status: 'UPLOADED',
                uploadedById: ctx.actor.userId,
              },
              select: {
                id: true,
                code: true,
                source: true,
                fileName: true,
                fileHash: true,
                fileSize: true,
                mimeType: true,
                status: true,
                uploadedById: true,
                createdAt: true,
              },
            });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'IMPORT_UPLOADED',
                entityType: 'IMPORT_BATCH',
                entityId: batch.id,
                entityLabel: batch.code,
                description: `Uploaded statement import ${batch.code}: ${batch.fileName}`,
                changes: {
                  code: { from: null, to: batch.code },
                  fileName: { from: null, to: batch.fileName },
                  fileHash: { from: null, to: batch.fileHash },
                  source: { from: null, to: batch.source },
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

            return { status: 201, body: { data: batch } };
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
