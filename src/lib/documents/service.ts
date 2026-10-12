import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type AuditAction, type AuditEntityType, type DocumentCategory, type DocumentLinkType, type DocumentStatus } from '@/generated/prisma/client';
import { prisma, type Tx } from '@/lib/db/prisma';
import { env } from '@/lib/env';
import { recordAuditEvent, withAudit } from '@/lib/db/with-audit';
import { writeAuditEntry } from '@/lib/audit/writer';
import type { RequestContext } from '@/lib/kernel/context';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/kernel/errors';
import { createApprovalRequest, advanceRequest } from '@/lib/approvals';
import type { ApprovalDecision, ConditionContext } from '@/lib/approvals';
import { scanDocumentUpload, stubOcrAdapter } from './adapters';
import { documentStorage } from './storage';

export const DOCUMENT_CATEGORIES = [
  'RECEIPT', 'INVOICE', 'QUOTATION', 'CONTRACT', 'GRANT_DOCUMENT', 'TAX_DOCUMENT',
  'COMPLIANCE_DOCUMENT', 'FINANCIAL_EVIDENCE', 'ASSET_DOCUMENT', 'SUPPLIER_DOCUMENT',
  'CUSTOMER_DOCUMENT', 'BANK_STATEMENT', 'RECONCILIATION_SUPPORT', 'OTHER',
] as const satisfies readonly DocumentCategory[];

export const DOCUMENT_LINK_TYPES = [
  'EVIDENCE', 'SUPPORTING', 'PRIMARY', 'CONTRACT', 'AMENDMENT',
] as const satisfies readonly DocumentLinkType[];

const LINKABLE_ENTITY_TYPES = [
  'TRANSACTION', 'INVOICE', 'PAYMENT', 'RECEIPT', 'QUOTATION', 'SUPPLIER', 'CUSTOMER',
  'PROJECT', 'FUNDING_SOURCE', 'JOURNAL_ENTRY', 'TREASURY_ACCOUNT', 'BUDGET',
  'RECONCILIATION_SESSION',
] as const;

export type LinkableEntityType = (typeof LINKABLE_ENTITY_TYPES)[number];

export interface UploadDocumentInput {
  fileName: string;
  mimeType: string;
  bytes: Buffer;
  title: string;
  description?: string | null;
  category: DocumentCategory;
  metadata?: Prisma.InputJsonValue;
  expiryDate?: Date | null;
  renewalDueAt?: Date | null;
  renewalOfId?: string | null;
}

export interface DocumentListFilters {
  category?: DocumentCategory;
  status?: DocumentStatus;
  tag?: string;
  entityType?: string;
  entityId?: string;
  expiryFrom?: Date;
  expiryTo?: Date;
  search?: string;
  limit?: number;
}

function organizationId(ctx: RequestContext): string {
  if (!ctx.actor.organizationId) throw new ValidationError('No organization context');
  return ctx.actor.organizationId;
}

function auditActor(ctx: RequestContext) {
  return { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes };
}

function auditOptions(ctx: RequestContext) {
  return {
    organizationId: ctx.actor.organizationId,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
    sessionId: ctx.actor.sessionId,
  };
}

function auditContext(ctx: RequestContext) {
  return { ...auditOptions(ctx), actor: auditActor(ctx) };
}

async function auditMutation<T>(
  ctx: RequestContext,
  event: { action: AuditAction; entityId?: string; entityType?: AuditEntityType; entityLabel?: string; description: string; metadata?: Record<string, Prisma.InputJsonValue | null> },
  operation: (tx: Tx) => Promise<T>,
): Promise<T> {
  return withAudit(auditContext(ctx), async (tx) => {
    const result = await operation(tx);
    const resultId = typeof result === 'object' && result !== null && 'id' in result && typeof result.id === 'string'
      ? result.id
      : undefined;
    const entityId = event.entityId ?? resultId ?? null;
    await writeAuditEntry(tx, auditActor(ctx), {
      action: event.action,
      entityType: event.entityType ?? 'DOCUMENT',
      entityId,
      entityLabel: event.entityLabel ?? entityId,
      description: event.description,
      metadata: event.metadata ?? null,
      result: 'SUCCESS',
    }, auditOptions(ctx));
    return result;
  });
}

function safeFileName(fileName: string): string {
  const safe = fileName.replace(/[\\/\u0000-\u001f\u007f]/g, '_').trim().slice(0, 200);
  return safe || 'document';
}

function matchesMimeSignature(mimeType: string, bytes: Buffer): boolean {
  if (mimeType === 'application/pdf') return bytes.subarray(0, 5).toString('ascii') === '%PDF-';
  if (mimeType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === 'image/gif') {
    const header = bytes.subarray(0, 6).toString('ascii');
    return header === 'GIF87a' || header === 'GIF89a';
  }
  if (mimeType === 'image/webp') return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (mimeType === 'image/bmp') return bytes.subarray(0, 2).toString('ascii') === 'BM';
  if (mimeType === 'image/tiff') {
    return (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0) ||
      (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0 && bytes[3] === 0x2a);
  }
  if (mimeType === 'image/avif' || mimeType === 'image/heic') {
    const brand = bytes.subarray(8, 12).toString('ascii');
    return brand === 'avif' || brand === 'avis' || brand === 'heic' || brand === 'heix' || brand === 'mif1';
  }
  return false;
}

function checksum(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function findDocument(organization: string, id: string) {
  const document = await prisma.document.findFirst({
    where: { id, organizationId: organization, deletedAt: null },
  });
  if (!document) throw new NotFoundError('Document', id);
  return document;
}

export async function uploadDocument(ctx: RequestContext, input: UploadDocumentInput) {
  const orgId = organizationId(ctx);
  if (input.renewalOfId) await findDocument(orgId, input.renewalOfId);
  if (!input.title.trim()) throw new ValidationError('A document title is required.');
  const settings = env();
  const fileName = safeFileName(input.fileName);
  const mimeType = input.mimeType.toLowerCase().trim();
  const maxBytes = settings.DOCUMENT_MAX_FILE_BYTES;
  const allowedTypes = settings.DOCUMENT_ALLOWED_MIME_TYPES.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);

  if (input.bytes.length === 0) throw new ValidationError('The uploaded file is empty.');
  if (input.bytes.length > maxBytes) {
    throw new ValidationError(`The file exceeds the configured ${maxBytes} byte size limit.`, { maxBytes });
  }
  if (!allowedTypes.includes(mimeType) || !matchesMimeSignature(mimeType, input.bytes)) {
    throw new ValidationError('Only valid PDF, JPEG and PNG documents are accepted.');
  }

  const scan = await scanDocumentUpload({ fileName, mimeType, byteLength: input.bytes.length });
  if (!scan.clean) throw new ValidationError('The uploaded file did not pass the virus scan.');

  const digest = checksum(input.bytes);
  const duplicateVersion = await prisma.documentVersion.findFirst({
    where: {
      organizationId: orgId,
      checksum: digest,
      document: { organizationId: orgId, deletedAt: null },
    },
    include: { document: true },
  });
  if (duplicateVersion) {
    await recordAuditEvent({ ...auditOptions(ctx), actor: auditActor(ctx) }, {
      action: 'DOCUMENT_UPLOADED',
      entityType: 'DOCUMENT',
      entityId: duplicateVersion.document.id,
      entityLabel: duplicateVersion.document.title,
      description: `Duplicate document upload detected for ${duplicateVersion.document.title}`,
      metadata: { checksum: digest, deduplicated: true, matchedVersion: duplicateVersion.version },
      result: 'SUCCESS',
    });
    return { document: duplicateVersion.document, deduplicated: true };
  }

  const storageKey = `${orgId}/${randomUUID()}`;
  const storage = documentStorage();
  await storage.put(storageKey, mimeType, input.bytes);
  try {
    const document = await withAudit(auditContext(ctx), async (tx) => {
      const created = await tx.document.create({
        data: {
          organizationId: orgId,
          title: input.title.trim(),
          description: input.description ?? null,
          category: input.category,
          fileName,
          mimeType,
          fileSize: input.bytes.length,
          checksum: digest,
          storageKey,
          metadata: input.metadata,
          expiryDate: input.expiryDate ?? null,
          renewalDueAt: input.renewalDueAt ?? null,
          renewalOfId: input.renewalOfId ?? null,
          uploadedById: ctx.actor.userId,
          versions: {
            create: {
              organizationId: orgId,
              version: 1,
              fileName,
              mimeType,
              fileSize: input.bytes.length,
              checksum: digest,
              storageKey,
              reason: 'Initial upload',
              createdById: ctx.actor.userId,
            },
          },
        },
        include: { versions: true },
      });
      const ocr = await stubOcrAdapter.process({ documentId: created.id, storageKey, mimeType });
      const updated = await tx.document.update({
        where: { id: created.id },
        data: { ocrStatus: ocr.status, ocrText: ocr.text, ocrConfidence: ocr.confidence },
        include: { versions: true },
      });
      await writeAuditEntry(tx, auditActor(ctx), {
        action: 'DOCUMENT_UPLOADED',
        entityType: 'DOCUMENT',
        entityId: created.id,
        entityLabel: created.title,
        description: `Uploaded document ${created.title}`,
        metadata: { fileName, mimeType, fileSize: input.bytes.length, checksum: digest, category: input.category },
        result: 'SUCCESS',
      }, auditOptions(ctx));
      return updated;
    });
    return { document, deduplicated: false };
  } catch (error) {
    await storage.remove(storageKey).catch(() => undefined);
    throw error;
  }
}

export async function listDocuments(orgId: string, filters: DocumentListFilters = {}) {
  const where: Prisma.DocumentWhereInput = { organizationId: orgId, deletedAt: null };
  if (filters.category) where.category = filters.category;
  if (filters.status) where.status = filters.status;
  if (filters.tag) where.tags = { some: { tag: { name: filters.tag, deletedAt: null } } };
  if (filters.entityType || filters.entityId) {
    where.links = { some: {
      organizationId: orgId,
      deletedAt: null,
      ...(filters.entityType ? { entityType: filters.entityType } : {}),
      ...(filters.entityId ? { entityId: filters.entityId } : {}),
    } };
  }
  if (filters.expiryFrom || filters.expiryTo) {
    where.expiryDate = {
      ...(filters.expiryFrom ? { gte: filters.expiryFrom } : {}),
      ...(filters.expiryTo ? { lte: filters.expiryTo } : {}),
    };
  }
  if (filters.search) {
    where.OR = [
      { title: { contains: filters.search, mode: 'insensitive' } },
      { description: { contains: filters.search, mode: 'insensitive' } },
      { ocrText: { contains: filters.search, mode: 'insensitive' } },
    ];
  }
  return prisma.document.findMany({
    where,
    orderBy: [{ expiryDate: 'asc' }, { updatedAt: 'desc' }],
    take: Math.min(100, Math.max(1, filters.limit ?? 50)),
    select: {
      id: true, title: true, description: true, category: true, status: true,
      fileName: true, mimeType: true, fileSize: true, currentVersion: true,
      expiryDate: true, renewalDueAt: true, ocrStatus: true, createdAt: true, updatedAt: true,
      tags: { select: { tag: { select: { id: true, name: true } } } },
      links: { where: { deletedAt: null }, select: { id: true, entityType: true, entityId: true, linkType: true, isPrimary: true } },
    },
  });
}

export async function searchDocuments(orgId: string, query: string, limit = 50) {
  const text = query.trim();
  if (text.length < 2) throw new ValidationError('Search terms must contain at least two characters.');
  return listDocuments(orgId, { search: text, limit });
}

export async function getDocumentDetail(orgId: string, id: string) {
  const document = await prisma.document.findFirst({
    where: { id, organizationId: orgId, deletedAt: null },
    include: {
      versions: { orderBy: { version: 'desc' } },
      tags: { where: { tag: { deletedAt: null } }, include: { tag: true } },
      links: { where: { deletedAt: null }, orderBy: { createdAt: 'desc' } },
      renewalOf: { select: { id: true, title: true, expiryDate: true } },
      renewals: { select: { id: true, title: true, expiryDate: true, status: true }, orderBy: { createdAt: 'desc' } },
    },
  });
  if (!document) throw new NotFoundError('Document', id);
  const [retentionPolicy, legalHolds, approvalRequest] = await Promise.all([
    prisma.retentionPolicy.findFirst({ where: { organizationId: orgId, category: document.category, isActive: true } }),
    prisma.legalHold.findMany({ where: { organizationId: orgId, entityType: 'DOCUMENT', entityId: id }, orderBy: { placedAt: 'desc' } }),
    document.approvalRequestId ? prisma.approvalRequest.findUnique({ where: { id: document.approvalRequestId }, select: { id: true, status: true, submittedAt: true, decidedAt: true } }) : null,
  ]);
  return { ...document, retentionPolicy, legalHolds, approvalRequest };
}

export interface UpdateDocumentInput {
  title?: string;
  description?: string | null;
  category?: DocumentCategory;
  metadata?: Prisma.InputJsonValue | null;
  expiryDate?: Date | null;
  renewalDueAt?: Date | null;
  renewalOfId?: string | null;
}

export async function updateDocument(ctx: RequestContext, id: string, input: UpdateDocumentInput) {
  const orgId = organizationId(ctx);
  const current = await findDocument(orgId, id);
  if (input.renewalOfId === id) throw new ValidationError('A document cannot renew itself.');
  if (input.renewalOfId) await findDocument(orgId, input.renewalOfId);
  const data: Prisma.DocumentUpdateInput = {
    ...(input.title !== undefined ? { title: input.title.trim() } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.category !== undefined ? { category: input.category } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata === null ? Prisma.JsonNull : input.metadata } : {}),
    ...(input.expiryDate !== undefined ? { expiryDate: input.expiryDate } : {}),
    ...(input.renewalDueAt !== undefined ? { renewalDueAt: input.renewalDueAt } : {}),
    ...(input.renewalOfId !== undefined ? { renewalOf: input.renewalOfId ? { connect: { id: input.renewalOfId } } : { disconnect: true } } : {}),
  };
  return auditMutation(ctx, {
    action: 'DOCUMENT_UPDATED', entityId: id, description: `Updated document ${current.title}`,
    metadata: { updatedFields: Object.keys(input) },
  }, (tx) => tx.document.update({ where: { id }, data }));
}

export async function softDeleteDocument(ctx: RequestContext, id: string) {
  const orgId = organizationId(ctx);
  const current = await findDocument(orgId, id);
  const hold = await prisma.legalHold.findFirst({
    where: { organizationId: orgId, entityType: 'DOCUMENT', entityId: id, releasedAt: null },
    select: { id: true, reason: true },
  });
  if (hold) throw new ConflictError('This document is under legal hold and cannot be deleted.', { legalHoldId: hold.id });
  return auditMutation(ctx, {
    action: 'DOCUMENT_DELETED', entityId: id, description: `Soft-deleted document ${current.title}`,
  }, (tx) => tx.document.update({ where: { id }, data: { deletedAt: new Date(), status: 'ARCHIVED' } }));
}

export async function addDocumentVersion(ctx: RequestContext, id: string, input: UploadDocumentInput & { reason: string }) {
  const orgId = organizationId(ctx);
  const current = await findDocument(orgId, id);
  if (!input.reason.trim()) throw new ValidationError('A reason is required for each new version.');
  const settings = env();
  const mimeType = input.mimeType.toLowerCase().trim();
  const allowed = settings.DOCUMENT_ALLOWED_MIME_TYPES.split(',').map((value) => value.trim().toLowerCase());
  if (!input.bytes.length || input.bytes.length > settings.DOCUMENT_MAX_FILE_BYTES) throw new ValidationError('The uploaded version is empty or exceeds the configured size limit.');
  if (!allowed.includes(mimeType) || !matchesMimeSignature(mimeType, input.bytes)) throw new ValidationError('Only valid PDF, JPEG and PNG documents are accepted.');
  const scan = await scanDocumentUpload({ fileName: safeFileName(input.fileName), mimeType, byteLength: input.bytes.length });
  if (!scan.clean) throw new ValidationError('The uploaded file did not pass the virus scan.');

  const digest = checksum(input.bytes);
  if (current.checksum === digest || await prisma.documentVersion.findFirst({ where: { organizationId: orgId, documentId: id, checksum: digest } })) {
    await recordAuditEvent({ ...auditOptions(ctx), actor: auditActor(ctx) }, {
      action: 'DOCUMENT_UPLOADED', entityType: 'DOCUMENT', entityId: id,
      description: `Duplicate version upload detected for ${current.title}`,
      metadata: { checksum: digest, deduplicated: true }, result: 'SUCCESS',
    });
    return { document: current, deduplicated: true };
  }

  const fileName = safeFileName(input.fileName);
  const storageKey = `${orgId}/${randomUUID()}`;
  const storage = documentStorage();
  await storage.put(storageKey, mimeType, input.bytes);
  try {
    const document = await auditMutation(ctx, {
      action: 'DOCUMENT_UPLOADED', entityId: id,
      description: `Uploaded version ${current.currentVersion + 1} of ${current.title}`,
      metadata: { version: current.currentVersion + 1, reason: input.reason.trim(), checksum: digest },
    }, async (tx) => {
      const updated = await tx.document.update({
        where: { id },
        data: {
          fileName, mimeType, fileSize: input.bytes.length, checksum: digest, storageKey,
          currentVersion: { increment: 1 }, ocrStatus: 'NOT_RUN', ocrText: null, ocrConfidence: null,
        },
      });
      await tx.documentVersion.create({
        data: {
          organizationId: orgId,
          documentId: id, version: updated.currentVersion, fileName, mimeType,
          fileSize: input.bytes.length, checksum: digest, storageKey,
          reason: input.reason.trim(), createdById: ctx.actor.userId,
        },
      });
      const ocr = await stubOcrAdapter.process({ documentId: id, storageKey, mimeType });
      return tx.document.update({ where: { id }, data: { ocrStatus: ocr.status, ocrText: ocr.text, ocrConfidence: ocr.confidence } });
    });
    return { document, deduplicated: false };
  } catch (error) {
    await storage.remove(storageKey).catch(() => undefined);
    throw error;
  }
}

export async function assertLinkableEntityInOrganization(tx: Tx, orgId: string, entityType: string, entityId: string): Promise<LinkableEntityType> {
  if (!(LINKABLE_ENTITY_TYPES as readonly string[]).includes(entityType)) {
    throw new ValidationError(`Unsupported document link entity type: ${entityType}`);
  }
  const found = await (async () => {
    switch (entityType as LinkableEntityType) {
      case 'TRANSACTION': return tx.transaction.findFirst({ where: { id: entityId, organizationId: orgId }, select: { id: true } });
      case 'INVOICE': return tx.invoice.findFirst({ where: { id: entityId, organizationId: orgId }, select: { id: true } });
      case 'PAYMENT': return tx.payment.findFirst({ where: { id: entityId, organizationId: orgId }, select: { id: true } });
      case 'RECEIPT': return tx.receipt.findFirst({ where: { id: entityId, organizationId: orgId }, select: { id: true } });
      case 'QUOTATION': return tx.quotation.findFirst({ where: { id: entityId, organizationId: orgId }, select: { id: true } });
      case 'SUPPLIER': return tx.supplier.findFirst({ where: { id: entityId, organizationId: orgId }, select: { id: true } });
      case 'CUSTOMER': return tx.customer.findFirst({ where: { id: entityId, organizationId: orgId }, select: { id: true } });
      case 'PROJECT': return tx.project.findFirst({ where: { id: entityId, organizationId: orgId }, select: { id: true } });
      case 'FUNDING_SOURCE': return tx.fundingSource.findFirst({ where: { id: entityId, organizationId: orgId }, select: { id: true } });
      case 'JOURNAL_ENTRY': return tx.journalEntry.findFirst({ where: { id: entityId, organizationId: orgId }, select: { id: true } });
      case 'TREASURY_ACCOUNT': return tx.treasuryAccount.findFirst({ where: { id: entityId, organizationId: orgId }, select: { id: true } });
      case 'BUDGET': return tx.budget.findFirst({ where: { id: entityId, organizationId: orgId }, select: { id: true } });
      case 'RECONCILIATION_SESSION': return tx.reconciliationSession.findFirst({ where: { id: entityId, organizationId: orgId }, select: { id: true } });
    }
  })();
  if (!found) throw new NotFoundError(entityType, entityId);
  return entityType as LinkableEntityType;
}

export async function addDocumentLink(ctx: RequestContext, id: string, input: {
  entityType: string; entityId: string; linkType: DocumentLinkType; isPrimary?: boolean;
}) {
  const orgId = organizationId(ctx);
  const doc = await findDocument(orgId, id);
  return auditMutation(ctx, {
    action: 'DOCUMENT_UPDATED', entityId: id,
    description: `Linked document ${doc.title} to ${input.entityType} ${input.entityId}`,
    metadata: { change: 'LINK_ADDED', entityType: input.entityType, entityId: input.entityId, linkType: input.linkType },
  }, async (tx) => {
    const entityType = await assertLinkableEntityInOrganization(tx, orgId, input.entityType, input.entityId);
    const prior = await tx.documentLink.findFirst({
      where: { organizationId: orgId, documentId: id, entityType, entityId: input.entityId, linkType: input.linkType },
      select: { id: true, deletedAt: true },
    });
    if (input.isPrimary) {
      await tx.documentLink.updateMany({
        where: { organizationId: orgId, entityType, entityId: input.entityId, deletedAt: null, isPrimary: true },
        data: { isPrimary: false },
      });
    }
    if (prior) {
      return tx.documentLink.update({
        where: { id: prior.id },
        data: { deletedAt: null, isPrimary: input.isPrimary ?? false },
      });
    }
    return tx.documentLink.create({
      data: {
        organizationId: orgId,
        documentId: id, entityType, entityId: input.entityId, linkType: input.linkType,
        isPrimary: input.isPrimary ?? false, createdById: ctx.actor.userId,
      },
    });
  });
}

export async function removeDocumentLink(ctx: RequestContext, id: string, linkId: string) {
  const orgId = organizationId(ctx);
  const doc = await findDocument(orgId, id);
  const link = await prisma.documentLink.findFirst({ where: { id: linkId, organizationId: orgId, documentId: id, deletedAt: null } });
  if (!link) throw new NotFoundError('Document link', linkId);
  return auditMutation(ctx, {
    action: 'DOCUMENT_UPDATED', entityId: id,
    description: `Removed ${link.entityType} link from document ${doc.title}`,
    metadata: { change: 'LINK_REMOVED', linkId },
  }, (tx) => tx.documentLink.update({ where: { id: linkId }, data: { deletedAt: new Date(), isPrimary: false } }));
}

export async function listDocumentTags(orgId: string) {
  return prisma.documentTag.findMany({ where: { organizationId: orgId, deletedAt: null }, orderBy: { name: 'asc' } });
}

export async function createDocumentTag(ctx: RequestContext, name: string) {
  const orgId = organizationId(ctx);
  const normalized = name.trim().replace(/\s+/g, ' ');
  if (normalized.length < 1 || normalized.length > 80) throw new ValidationError('Tag names must be between 1 and 80 characters.');
  return auditMutation(ctx, {
    action: 'DOCUMENT_UPDATED', entityType: 'DOCUMENT_TAG', entityLabel: normalized,
    description: `Created document tag ${normalized}`,
    metadata: { change: 'TAG_CREATED', name: normalized },
  }, async (tx) => {
    const existing = await tx.documentTag.findFirst({ where: { organizationId: orgId, name: normalized } });
    if (existing) {
      if (existing.deletedAt) return tx.documentTag.update({ where: { id: existing.id }, data: { deletedAt: null } });
      throw new ConflictError('A tag with this name already exists.');
    }
    return tx.documentTag.create({ data: { organizationId: orgId, name: normalized, createdById: ctx.actor.userId } });
  });
}

export async function applyDocumentTag(ctx: RequestContext, id: string, input: { tagId?: string; name?: string }) {
  const orgId = organizationId(ctx);
  const doc = await findDocument(orgId, id);
  return auditMutation(ctx, {
    action: 'DOCUMENT_UPDATED', entityId: id, description: `Applied tag to document ${doc.title}`,
    metadata: { change: 'TAG_APPLIED', tagId: input.tagId ?? null, name: input.name ?? null },
  }, async (tx) => {
    let tag = input.tagId
      ? await tx.documentTag.findFirst({ where: { id: input.tagId, organizationId: orgId, deletedAt: null } })
      : null;
    if (!tag && input.name) {
      const name = input.name.trim().replace(/\s+/g, ' ');
      tag = await tx.documentTag.findFirst({ where: { organizationId: orgId, name } });
      if (!tag) tag = await tx.documentTag.create({ data: { organizationId: orgId, name, createdById: ctx.actor.userId } });
      else if (tag.deletedAt) tag = await tx.documentTag.update({ where: { id: tag.id }, data: { deletedAt: null } });
    }
    if (!tag) throw new NotFoundError('Document tag', input.tagId);
    const link = await tx.documentTagLink.findFirst({ where: { organizationId: orgId, documentId: id, tagId: tag.id } });
    if (link) return link;
    return tx.documentTagLink.create({ data: { organizationId: orgId, documentId: id, tagId: tag.id, createdById: ctx.actor.userId } });
  });
}

export async function removeDocumentTag(ctx: RequestContext, id: string, tagId: string) {
  const orgId = organizationId(ctx);
  const doc = await findDocument(orgId, id);
  const tag = await prisma.documentTag.findFirst({ where: { id: tagId, organizationId: orgId, deletedAt: null } });
  if (!tag) throw new NotFoundError('Document tag', tagId);
  const link = await prisma.documentTagLink.findFirst({ where: { organizationId: orgId, documentId: id, tagId } });
  if (!link) throw new NotFoundError('Document tag link', tagId);
  await auditMutation(ctx, {
    action: 'DOCUMENT_UPDATED', entityId: id, description: `Removed tag ${tag.name} from ${doc.title}`,
    metadata: { change: 'TAG_REMOVED', tagId },
  }, (tx) => tx.documentTagLink.delete({ where: { id: link.id } }));
}

export async function submitDocumentForApproval(ctx: RequestContext, id: string) {
  const orgId = organizationId(ctx);
  const document = await findDocument(orgId, id);
  if (document.status === 'PENDING_APPROVAL') throw new ConflictError('This document is already pending approval.');
  if (document.status === 'ARCHIVED') throw new ConflictError('Archived documents cannot be submitted for approval.');
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { baseCurrency: true } });
  const condition: ConditionContext = {
    organizationId: orgId, entityType: 'DOCUMENT', entityId: id,
    submittedById: ctx.actor.userId, amount: 1, currencyCode: org.baseCurrency,
  };
  return withAudit(auditContext(ctx), async (tx) => {
    const request = await createApprovalRequest({
      organizationId: orgId, entityType: 'DOCUMENT', entityId: id,
      // The approval engine requires an amount even for non-monetary records.
      // One base-currency unit is a neutral sentinel; document policy uses ALWAYS.
      amount: 1, currencyCode: org.baseCurrency, submittedById: ctx.actor.userId, context: condition,
    }, tx as Prisma.TransactionClient);
    await tx.document.update({ where: { id }, data: { status: 'PENDING_APPROVAL', approvalRequestId: request.id, approvedById: null, approvedAt: null } });
    await writeAuditEntry(tx, auditActor(ctx), {
      action: 'DOCUMENT_APPROVAL_SUBMITTED', entityType: 'DOCUMENT', entityId: id,
      entityLabel: document.title, description: `Submitted ${document.title} for approval`,
      metadata: { approvalRequestId: request.id },
    }, auditOptions(ctx));
    return request;
  });
}

export async function decideDocumentApproval(
  ctx: RequestContext,
  id: string,
  requestId: string,
  decision: Extract<ApprovalDecision, 'APPROVED' | 'REJECTED'>,
  reason: string,
) {
  const orgId = organizationId(ctx);
  await findDocument(orgId, id);
  const request = await prisma.approvalRequest.findFirst({
    where: { id: requestId, organizationId: orgId, entityType: 'DOCUMENT', entityId: id },
    select: { id: true },
  });
  if (!request) throw new NotFoundError('Document approval request', requestId);
  return prisma.$transaction((tx) => advanceRequest(requestId, decision, {
    userId: ctx.actor.userId, fullName: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes,
  }, { reason, tx }));
}

export async function placeLegalHold(ctx: RequestContext, entityType: string, entityId: string, reason: string) {
  const orgId = organizationId(ctx);
  const cleanReason = reason.trim();
  if (cleanReason.length < 5) throw new ValidationError('A legal hold reason of at least five characters is required.');
  return auditMutation(ctx, {
    action: 'LEGAL_HOLD_PLACED', entityType: 'LEGAL_HOLD', entityLabel: `${entityType}:${entityId}`,
    description: `Placed a legal hold on ${entityType} ${entityId}`,
    metadata: { entityType, reason: cleanReason, approvedById: ctx.actor.userId },
  }, async (tx) => {
    if (entityType === 'DOCUMENT') await findDocument(orgId, entityId);
    else await assertLinkableEntityInOrganization(tx, orgId, entityType, entityId);
    const existing = await tx.legalHold.findFirst({ where: { organizationId: orgId, entityType, entityId, releasedAt: null } });
    if (existing) throw new ConflictError('An active legal hold already exists for this entity.');
    return tx.legalHold.create({
      data: { organizationId: orgId, entityType, entityId, reason: cleanReason, heldById: ctx.actor.userId, approvedById: ctx.actor.userId },
    });
  });
}

export async function releaseLegalHold(ctx: RequestContext, holdId: string, reason: string) {
  const orgId = organizationId(ctx);
  const cleanReason = reason.trim();
  if (cleanReason.length < 5) throw new ValidationError('A release reason of at least five characters is required.');
  const hold = await prisma.legalHold.findFirst({ where: { id: holdId, organizationId: orgId, releasedAt: null } });
  if (!hold) throw new NotFoundError('Active legal hold', holdId);
  return auditMutation(ctx, {
    action: 'LEGAL_HOLD_RELEASED', entityType: 'LEGAL_HOLD', entityId: hold.id,
    entityLabel: `${hold.entityType}:${hold.entityId}`,
    description: `Released the legal hold on ${hold.entityType} ${hold.entityId}`,
    metadata: { holdId, entityType: hold.entityType, releaseReason: cleanReason },
  }, (tx) => tx.legalHold.update({
    where: { id: holdId },
    data: { releasedAt: new Date(), releasedById: ctx.actor.userId, releaseReason: cleanReason },
  }));
}

export async function listRetentionPolicies(orgId: string) {
  return prisma.retentionPolicy.findMany({ where: { organizationId: orgId }, orderBy: { category: 'asc' } });
}

export async function saveRetentionPolicy(ctx: RequestContext, input: {
  name: string; category: DocumentCategory; retentionMonths: number; action: 'ARCHIVE' | 'DELETE' | 'RETAIN_FOREVER'; legalBasis: string; isActive?: boolean;
}) {
  const orgId = organizationId(ctx);
  if (input.retentionMonths < 0 || (input.retentionMonths === 0 && input.action !== 'RETAIN_FOREVER')) {
    throw new ValidationError('Retention months must be positive unless the action is RETAIN_FOREVER.');
  }
  if (!input.legalBasis.trim()) throw new ValidationError('A legal basis is required.');
  return auditMutation(ctx, {
    action: 'RETENTION_POLICY_UPDATED', entityType: 'RETENTION_POLICY', entityLabel: input.category,
    description: `Set retention policy for ${input.category}`,
    metadata: { category: input.category, action: input.action, retentionMonths: input.retentionMonths },
  }, (tx) => tx.retentionPolicy.upsert({
    where: { organizationId_category: { organizationId: orgId, category: input.category } },
    create: {
      organizationId: orgId, name: input.name.trim(), category: input.category,
      retentionMonths: input.retentionMonths, action: input.action,
      legalBasis: input.legalBasis.trim(), isActive: input.isActive ?? true, createdById: ctx.actor.userId,
    },
    update: {
      name: input.name.trim(), retentionMonths: input.retentionMonths,
      action: input.action, legalBasis: input.legalBasis.trim(), isActive: input.isActive ?? true,
    },
  }));
}

export async function documentForDownload(orgId: string, id: string) {
  const document = await prisma.document.findFirst({
    where: { id, organizationId: orgId, deletedAt: null, status: { not: 'ARCHIVED' } },
    select: { id: true, title: true, fileName: true, mimeType: true, fileSize: true, storageKey: true, currentVersion: true, checksum: true },
  });
  if (!document) throw new NotFoundError('Document', id);
  return document;
}

export async function readDocumentBytes(storageKey: string) {
  return documentStorage().get(storageKey);
}
