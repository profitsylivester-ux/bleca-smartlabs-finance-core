import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/db/prisma';
import { resetEnvCache } from '@/lib/env';
import { uploadDocument, placeLegalHold, softDeleteDocument, saveRetentionPolicy } from '@/lib/documents/service';
import { runDocumentMaintenance } from '@/lib/documents/maintenance';
import { signDocumentDownload, verifyDocumentDownload } from '@/lib/documents/download-url';
import { TransactionService } from '@/lib/transactions/service';
import type { RequestContext } from '@/lib/kernel/context';
import type { DocumentCategory } from '@/generated/prisma/client';

const { mockRequireContext, mockRequestId } = vi.hoisted(() => ({
  mockRequireContext: vi.fn(),
  mockRequestId: vi.fn(async () => 'm12-integration-test'),
}));

vi.mock('@/lib/auth/guard', () => ({ requireContext: mockRequireContext }));
vi.mock('@/lib/api/responses', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/responses')>();
  return { ...actual, requestId: mockRequestId };
});

import { GET as downloadRoute } from '@/app/api/v1/documents/[id]/download/route';
import { GET as searchRoute } from '@/app/api/v1/documents/search/route';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
let organizationId = '';
let storageRoot = '';
let submitterId = '';
let viewerId = '';
let ceoId = '';
let ceoRoleId = '';
let uploaded: Awaited<ReturnType<typeof uploadDocument>>['document'];

function context(userId: string, roleCodes: string[] = []): RequestContext {
  return {
    actor: {
      userId,
      email: `${userId}@example.test`,
      fullName: 'M12 Integration Actor',
      roleCodes,
      isFinalApprover: roleCodes.includes('CEO'),
      organizationId,
      sessionId: null,
      mfaSatisfiedAt: new Date(),
      stepUpSatisfiedAt: null,
      stepUpExpiresAt: null,
    },
    requestId: 'm12-integration-test',
    channel: 'WEB',
    idempotencyKey: null,
    ipAddress: null,
    userAgent: 'vitest',
    syncBatchId: null,
  };
}

async function createUser(name: string, withCeoRole = false): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `${name}-${suffix}@example.test`,
      emailNormalized: `${name}-${suffix}@example.test`,
      fullName: 'M12 Test User',
      status: 'ACTIVE',
      isActive: true,
    },
    select: { id: true },
  });
  await prisma.organizationMembership.create({
    data: { userId: user.id, organizationId, isDefault: true },
  });
  if (withCeoRole) {
    await prisma.userRole.create({
      data: { userId: user.id, roleId: ceoRoleId, reason: 'M12 integration access' },
    });
  }
  return user.id;
}

function pdfBytes(label: string): Buffer {
  return Buffer.from(`%PDF-1.7\n${label}\n%%EOF`);
}

async function upload(ctx: RequestContext, title: string, category: DocumentCategory = 'OTHER') {
  return uploadDocument(ctx, {
    fileName: `${title.replaceAll(' ', '-')}.pdf`,
    mimeType: 'application/pdf',
    bytes: pdfBytes(title),
    title,
    category,
  });
}

beforeAll(async () => {
  process.env.STORAGE_DRIVER = 'local';
  storageRoot = await mkdtemp(path.join(tmpdir(), 'bleca-m12-'));
  process.env.STORAGE_LOCAL_ROOT = storageRoot;
  process.env.DOCUMENT_MAX_FILE_BYTES = '15728640';
  process.env.DOCUMENT_ALLOWED_MIME_TYPES = 'application/pdf,image/jpeg,image/png';
  process.env.DOCUMENT_SIGNED_URL_TTL_SECONDS = '300';
  resetEnvCache();

  const organization = await prisma.organization.findUniqueOrThrow({ where: { code: 'BLECA' }, select: { id: true } });
  organizationId = organization.id;
  ceoRoleId = (await prisma.role.findUniqueOrThrow({ where: { code: 'CEO' }, select: { id: true } })).id;
  submitterId = await createUser('m12-submitter');
  viewerId = await createUser('m12-viewer');
  ceoId = await createUser('m12-ceo', true);
  mockRequireContext.mockResolvedValue(context(ceoId, ['CEO']));
});

afterAll(async () => {
  const relative = path.relative(tmpdir(), storageRoot);
  if (relative.startsWith('bleca-m12-') && !relative.startsWith(`..${path.sep}`)) {
    await rm(storageRoot, { recursive: true, force: true });
  }
});

describe('M12 Document Management', () => {
  it('uploads an allowed PDF and audits the upload', async () => {
    const result = await upload(context(submitterId), 'M12 valid evidence');
    expect(result.deduplicated).toBe(false);
    expect(result.document.mimeType).toBe('application/pdf');
    expect(result.document.ocrStatus).toBe('NOT_RUN');
    expect(result.document.currentVersion).toBe(1);
    uploaded = result.document;
    const audit = await prisma.auditLog.findFirst({
      where: { entityType: 'DOCUMENT', entityId: uploaded.id, action: 'DOCUMENT_UPLOADED' },
      orderBy: { sequence: 'desc' },
    });
    expect(audit?.result).toBe('SUCCESS');
  });

  it('rejects an unsupported type and an oversized upload', async () => {
    await expect(uploadDocument(context(submitterId), {
      fileName: 'bad.txt', mimeType: 'text/plain', bytes: Buffer.from('not a pdf'),
      title: 'Wrong type', category: 'OTHER',
    })).rejects.toThrow(/valid PDF/);
    await expect(uploadDocument(context(submitterId), {
      fileName: 'large.pdf', mimeType: 'application/pdf',
      bytes: Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(15 * 1024 * 1024)]),
      title: 'Too large', category: 'OTHER',
    })).rejects.toThrow(/size limit/);
  });

  it('detects identical uploads by SHA-256 checksum', async () => {
    const data = pdfBytes('M12 duplicate content');
    const input = { fileName: 'duplicate.pdf', mimeType: 'application/pdf', bytes: data, title: 'Duplicate content', category: 'OTHER' as const };
    const first = await uploadDocument(context(submitterId), input);
    const duplicate = await uploadDocument(context(submitterId), { ...input, fileName: 'renamed-copy.pdf' });
    expect(first.document.id).toBe(duplicate.document.id);
    expect(duplicate.deduplicated).toBe(true);
  });

  it('issues signed download links with an enforceable expiry timestamp', () => {
    const now = Date.now();
    const token = signDocumentDownload({ documentId: 'doc-1', organizationId, actorId: submitterId, expiresAt: now + 1_000 });
    expect(verifyDocumentDownload(token, now)?.documentId).toBe('doc-1');
    expect(verifyDocumentDownload(token, now + 1_001)).toBeNull();
  });

  it('refuses a download without permission and audits the refusal', async () => {
    mockRequireContext.mockResolvedValue(context(viewerId));
    const response = await downloadRoute(
      new Request(`http://localhost/api/v1/documents/${uploaded.id}/download?token=invalid`),
      { params: Promise.resolve({ id: uploaded.id }) },
    );
    expect(response.status).toBe(403);
    const audit = await prisma.auditLog.findFirst({
      where: { entityType: 'DOCUMENT', entityId: uploaded.id, action: 'DOCUMENT_DOWNLOADED', result: 'DENIED' },
      orderBy: { sequence: 'desc' },
    });
    expect(audit).not.toBeNull();
  });

  it('audits every successful download', async () => {
    const ctx = context(ceoId, ['CEO']);
    mockRequireContext.mockResolvedValue(ctx);
    const expiresAt = Date.now() + 60_000;
    const token = signDocumentDownload({ documentId: uploaded.id, organizationId, actorId: ceoId, expiresAt });
    const response = await downloadRoute(
      new Request(`http://localhost/api/v1/documents/${uploaded.id}/download?token=${encodeURIComponent(token)}`),
      { params: Promise.resolve({ id: uploaded.id }) },
    );
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(pdfBytes('M12 valid evidence'));
    const audit = await prisma.auditLog.findFirst({
      where: { entityType: 'DOCUMENT', entityId: uploaded.id, action: 'DOCUMENT_DOWNLOADED', result: 'SUCCESS' },
      orderBy: { sequence: 'desc' },
    });
    expect(audit).not.toBeNull();
  });

  it('keeps version history immutable at the database level', async () => {
    const version = await prisma.documentVersion.findFirstOrThrow({ where: { documentId: uploaded.id } });
    await expect(prisma.documentVersion.update({ where: { id: version.id }, data: { reason: 'rewritten' } }))
      .rejects.toThrow(/append-only/);
    await expect(prisma.documentVersion.delete({ where: { id: version.id } })).rejects.toThrow(/append-only/);
  });

  it('blocks soft deletion while a legal hold is active', async () => {
    const result = await upload(context(submitterId), 'M12 held evidence');
    await placeLegalHold(context(submitterId), 'DOCUMENT', result.document.id, 'Preserve pending review');
    await expect(softDeleteDocument(context(submitterId), result.document.id)).rejects.toThrow(/legal hold/);
    const stored = await prisma.document.findUniqueOrThrow({ where: { id: result.document.id }, select: { deletedAt: true } });
    expect(stored.deletedAt).toBeNull();
  });

  it('skips held documents when the retention job reaches its action date', async () => {
    const result = await upload(context(submitterId), 'M12 held retention evidence');
    await saveRetentionPolicy(context(submitterId), {
      name: 'M12 test retention', category: 'OTHER', retentionMonths: 1,
      action: 'DELETE', legalBasis: 'Integration test policy',
    });
    await prisma.document.update({ where: { id: result.document.id }, data: { createdAt: new Date('2020-01-01T00:00:00.000Z') } });
    await placeLegalHold(context(submitterId), 'DOCUMENT', result.document.id, 'Preserve retained test evidence');
    const job = await runDocumentMaintenance(new Date('2026-10-12T00:00:00.000Z'));
    expect(job.skippedHeld).toBeGreaterThanOrEqual(1);
    const stored = await prisma.document.findUniqueOrThrow({ where: { id: result.document.id }, select: { deletedAt: true } });
    expect(stored.deletedAt).toBeNull();
  });

  it('blocks posting a transaction whose account requires evidence when no document is attached', async () => {
    const account = await prisma.account.create({
      data: {
        organizationId, code: `M12-REQ-${suffix}`, name: 'Evidence required account',
        type: 'EXPENSE', normalBalance: 'DEBIT', requiresDocument: true,
      },
      select: { id: true },
    });
    const transaction = await prisma.transaction.create({
      data: { organizationId, date: new Date('2025-06-01T00:00:00.000Z'), amount: 10, currencyCode: 'TZS', accountId: account.id },
      select: { id: true },
    });
    const service = new TransactionService();
    await expect(service._doAction(prisma, transaction.id, organizationId, context(submitterId).actor, 'POSTED'))
      .rejects.toThrow(/requires a supporting document/);
  });

  it('generates a reminder for an expired document', async () => {
    const result = await upload(context(submitterId), 'M12 expired compliance proof', 'COMPLIANCE_DOCUMENT');
    await prisma.document.update({
      where: { id: result.document.id },
      data: { expiryDate: new Date('2026-10-11T00:00:00.000Z') },
    });
    const job = await runDocumentMaintenance(new Date('2026-10-12T00:00:00.000Z'));
    expect(job.remindersCreated).toBeGreaterThanOrEqual(1);
    const notification = await prisma.notification.findFirst({
      where: { userId: submitterId, category: 'DOCUMENT_EXPIRY', dedupeKey: { contains: result.document.id } },
    });
    expect(notification?.title).toContain('expired');
  });

  it('searches only documents in the actor organization when the actor has document view permission', async () => {
    const result = await upload(context(submitterId), `M12 Search Needle ${suffix}`);
    const secondOrganization = await prisma.organization.create({
      data: { code: `M12-${suffix}`, name: `M12 other org ${suffix}` }, select: { id: true },
    });
    await prisma.document.create({
      data: {
        organizationId: secondOrganization.id, title: `M12 Search Needle ${suffix}`,
        category: 'OTHER', fileName: 'private.pdf', mimeType: 'application/pdf', fileSize: 12,
        checksum: randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64),
        storageKey: `${secondOrganization.id}/private-object`, uploadedById: submitterId,
      },
    });

    mockRequireContext.mockResolvedValue(context(ceoId, ['CEO']));
    const response = await searchRoute(new Request(`http://localhost/api/v1/documents/search?q=${encodeURIComponent(`M12 Search Needle ${suffix}`)}`));
    expect(response.status).toBe(200);
    const body = await response.json() as { data: Array<{ id: string }> };
    expect(body.data.map((row) => row.id)).toEqual([result.document.id]);
  });
});
