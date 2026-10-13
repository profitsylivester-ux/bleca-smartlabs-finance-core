import { prisma } from '@/lib/db/prisma';
import type { RequestContext } from '@/lib/kernel/context';
import { authorize } from '@/lib/kernel/authorize';
import { writeAuditEntry } from '@/lib/audit/writer';
import { withAudit } from '@/lib/db/with-audit';
import { ValidationError } from '@/lib/kernel/errors';
import { detectDuplicates, type RuleHit } from './rules';
import { detectOutliers } from './outliers';
import { detectSupplierChangeThenPaid, detectSodViolations } from './fraud';

/** Anomaly scan + triage (M16). Flag-only; every transition is audited. */

export interface ScanResult {
  scannedAt: string;
  rulesRun: string[];
  flagsCreated: number;
  flagsSkipped: number;
}

export async function runAnomalyScan(ctx: RequestContext): Promise<ScanResult> {
  await authorize(ctx, { module: 'ANOMALY_DETECTION', action: 'VIEW' });
  if (!ctx.actor.organizationId) throw new Error('No organization context');
  const orgId = ctx.actor.organizationId;
  const rulesRun = ['duplicate', 'outlier', 'supplier-change-then-paid', 'sod'];
  const batches: RuleHit[][] = await Promise.all([
    detectDuplicates(orgId),
    detectOutliers(orgId),
    detectSupplierChangeThenPaid(orgId),
    detectSodViolations(orgId),
  ]);
  const hits = batches.flat();
  let created = 0;
  for (const hit of hits) {
    const r = await prisma.anomalyFlag.createMany({
      data: [{
        organizationId: orgId,
        anomalyType: hit.rule,
        severity: hit.severity,
        status: 'OPEN',
        entityType: hit.entityType,
        entityId: hit.entityId,
        entityLabel: hit.entityLabel,
        description: hit.description,
        evidence: hit.evidence as never,
        dedupeKey: hit.dedupeKey,
      }],
      skipDuplicates: true,
    });
    created += r.count;
  }
  await auditScan(ctx, orgId, rulesRun, hits.length, created);
  return { scannedAt: new Date().toISOString(), rulesRun, flagsCreated: created, flagsSkipped: hits.length - created };
}

export async function acknowledgeFlag(ctx: RequestContext, flagId: string): Promise<void> {
  await authorize(ctx, { module: 'ANOMALY_DETECTION', action: 'EDIT' });
  const flag = await prisma.anomalyFlag.findFirst({
    where: { id: flagId, organizationId: ctx.actor.organizationId ?? undefined },
  });
  if (!flag) throw new ValidationError('Anomaly flag was not found.');
  await triageAudit(ctx, flag.organizationId, flagId, flag.entityLabel, 'ANOMALY_FLAG_ACKNOWLEDGED', `Acknowledged anomaly ${flag.anomalyType} on ${flag.entityType} ${flag.entityLabel ?? flag.entityId}`, {
    status: 'ACKNOWLEDGED', acknowledgedAt: new Date(), acknowledgedById: ctx.actor.userId,
  });
}

export async function dismissFlag(ctx: RequestContext, flagId: string, reason: string): Promise<void> {
  await authorize(ctx, { module: 'ANOMALY_DETECTION', action: 'EDIT' });
  if (!reason || reason.trim().length < 5) {
    throw new ValidationError('A dismissal reason of at least 5 characters is required.');
  }
  const flag = await prisma.anomalyFlag.findFirst({
    where: { id: flagId, organizationId: ctx.actor.organizationId ?? undefined },
  });
  if (!flag) throw new ValidationError('Anomaly flag was not found.');
  await triageAudit(ctx, flag.organizationId, flagId, flag.entityLabel, 'ANOMALY_FLAG_DISMISSED', `Dismissed anomaly ${flag.anomalyType}: ${reason.trim()}`, {
    status: 'DISMISSED', dismissedAt: new Date(), dismissedById: ctx.actor.userId, dismissReason: reason.trim(),
  }, { reason: reason.trim() });
}

export async function confirmFlag(ctx: RequestContext, flagId: string): Promise<void> {
  await authorize(ctx, { module: 'ANOMALY_DETECTION', action: 'EDIT' });
  const flag = await prisma.anomalyFlag.findFirst({
    where: { id: flagId, organizationId: ctx.actor.organizationId ?? undefined },
  });
  if (!flag) throw new ValidationError('Anomaly flag was not found.');
  await triageAudit(ctx, flag.organizationId, flagId, flag.entityLabel, 'ANOMALY_FLAG_CONFIRMED', `Confirmed anomaly ${flag.anomalyType} on ${flag.entityType} ${flag.entityLabel ?? flag.entityId} — escalated for human follow-up`, {
    status: 'CONFIRMED', confirmedAt: new Date(), confirmedById: ctx.actor.userId,
  });
}

type TriageData = {
  status: 'ACKNOWLEDGED' | 'DISMISSED' | 'CONFIRMED';
  acknowledgedAt?: Date;
  acknowledgedById?: string;
  dismissedAt?: Date;
  dismissedById?: string;
  dismissReason?: string;
  confirmedAt?: Date;
  confirmedById?: string;
};

async function triageAudit(
  ctx: RequestContext,
  orgId: string,
  flagId: string,
  label: string | null,
  action: 'ANOMALY_FLAG_ACKNOWLEDGED' | 'ANOMALY_FLAG_DISMISSED' | 'ANOMALY_FLAG_CONFIRMED',
  description: string,
  data: TriageData,
  metadata?: Record<string, string>,
): Promise<void> {
  await withAudit(
    { organizationId: orgId, actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, requestId: ctx.requestId },
    async (tx) => {
      await tx.anomalyFlag.update({ where: { id: flagId }, data });
      await writeAuditEntry(
        tx,
        { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
        { action, entityType: 'ANOMALY_FLAG', entityId: flagId, entityLabel: label, description, metadata },
        { organizationId: orgId, requestId: ctx.requestId },
      );
    },
  );
}

async function auditScan(ctx: RequestContext, orgId: string, rules: string[], hits: number, created: number): Promise<void> {
  await withAudit(
    { organizationId: orgId, actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, requestId: ctx.requestId },
    async (tx) => {
      await writeAuditEntry(
        tx,
        { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
        {
          action: 'ANOMALY_SCAN_COMPLETED',
          entityType: 'ANOMALY_FLAG',
          description: `Anomaly scan completed: ${hits} hits, ${created} new flags`,
          metadata: { rulesRun: rules, hits, created },
        },
        { organizationId: orgId, requestId: ctx.requestId },
      );
    },
  );
}

