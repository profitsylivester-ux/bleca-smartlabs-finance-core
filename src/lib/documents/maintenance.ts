import { prisma } from '@/lib/db/prisma';
import { writeAuditEntry } from '@/lib/audit/writer';
import { withAudit } from '@/lib/db/with-audit';

export interface DocumentMaintenanceResult {
  remindersCreated: number;
  archived: number;
  softDeleted: number;
  skippedHeld: number;
}

function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  result.setUTCMonth(result.getUTCMonth() + months);
  return result;
}

/**
 * Scheduled-job entry point for M12. M17 can call this from the cron runner.
 * Reminder and retention writes are idempotent across repeated runs.
 */
export async function runDocumentMaintenance(now = new Date()): Promise<DocumentMaintenanceResult> {
  const result: DocumentMaintenanceResult = { remindersCreated: 0, archived: 0, softDeleted: 0, skippedHeld: 0 };
  const documents = await prisma.document.findMany({
    where: { deletedAt: null },
    select: {
      id: true, organizationId: true, title: true, category: true, uploadedById: true,
      createdAt: true, expiryDate: true,
    },
  });
  const policies = await prisma.retentionPolicy.findMany({ where: { isActive: true } });
  const policyByCategory = new Map(policies.map((policy) => [`${policy.organizationId}:${policy.category}`, policy]));

  for (const document of documents) {
    if (document.expiryDate) {
      const daysToExpiry = Math.ceil((document.expiryDate.getTime() - now.getTime()) / 86_400_000);
      let dueLabel: string | null = null;
      if (daysToExpiry < 0) dueLabel = 'expired';
      else if (daysToExpiry <= 30) dueLabel = '30-day';
      else if (daysToExpiry <= 60) dueLabel = '60-day';
      else if (daysToExpiry <= 90) dueLabel = '90-day';

      if (dueLabel) {
        const expiryDate = document.expiryDate.toISOString().slice(0, 10);
        const created = await prisma.notification.createMany({
          data: [{
            organizationId: document.organizationId,
            userId: document.uploadedById,
            category: 'DOCUMENT_EXPIRY',
            severity: daysToExpiry < 0 ? 'CRITICAL' : 'WARNING',
            channel: 'IN_APP',
            status: 'PENDING',
            title: daysToExpiry < 0 ? 'Document has expired' : `Document expires within ${dueLabel}`,
            body: `${document.title} expires on ${expiryDate}. Review it and record a renewal if needed.`,
            actionUrl: `/documents/${document.id}`,
            dedupeKey: `document-expiry:${document.id}:${expiryDate}:${dueLabel}`,
          }],
          skipDuplicates: true,
        });
        result.remindersCreated += created.count;
      }
    }

    const policy = policyByCategory.get(`${document.organizationId}:${document.category}`);
    if (!policy || policy.action === 'RETAIN_FOREVER' || addMonths(document.createdAt, policy.retentionMonths) > now) continue;

    const hold = await prisma.legalHold.findFirst({
      where: { organizationId: document.organizationId, entityType: 'DOCUMENT', entityId: document.id, releasedAt: null },
      select: { id: true },
    });
    if (hold) {
      result.skippedHeld += 1;
      continue;
    }

    const action = policy.action === 'DELETE' ? 'soft-deleted' : 'archived';
    await withAudit({
      organizationId: document.organizationId,
      actor: { id: null, name: 'Document retention job', roleCodes: ['SYSTEM'] },
    }, async (tx) => {
      await tx.document.update({
        where: { id: document.id },
        data: policy.action === 'DELETE'
          ? { deletedAt: now, status: 'ARCHIVED' }
          : { status: 'ARCHIVED' },
      });
      await writeAuditEntry(tx, { id: null, name: 'Document retention job', roleCodes: ['SYSTEM'] }, {
        action: 'RETENTION_APPLIED', entityType: 'DOCUMENT', entityId: document.id,
        entityLabel: document.title,
        description: `Retention policy ${policy.name} ${action} document ${document.title}`,
        metadata: { policyId: policy.id, policyAction: policy.action, legalBasis: policy.legalBasis },
      }, { organizationId: document.organizationId });
    });
    if (policy.action === 'DELETE') result.softDeleted += 1;
    else result.archived += 1;
  }

  return result;
}
