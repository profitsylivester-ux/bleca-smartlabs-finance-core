import { Prisma } from '@/generated/prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { prisma } from '@/lib/db/prisma';
import { writeAuditEntry } from '@/lib/audit/writer';
import { createApprovalRequest, advanceRequest } from '@/lib/approvals/engine';
import { runAllAutomatedChecks, CHECKLIST_DEFINITIONS } from './checks';
import { dec } from '@/lib/reports/internal';

export interface CloseSessionResult {
  closeId: string;
  periodId: string;
  status: string;
  checklistItems: Array<{
    itemKey: string;
    label: string;
    isBlocking: boolean;
    isAutomated: boolean;
    status: string;
    computedValue?: string | null;
  }>;
}

export interface ChecklistItemResult {
  itemKey: string;
  label: string;
  isBlocking: boolean;
  isAutomated: boolean;
  status: string;
  computedValue?: string | null;
  confirmedById?: string | null;
  confirmedAt?: Date | null;
  waivedById?: string | null;
  waivedAt?: Date | null;
  waiverReason?: string | null;
  waiverApproverId?: string | null;
  waiverApprovedAt?: Date | null;
}

/**
 * Start a new financial close session for a period.
 * Creates FinancialClose record and all checklist items.
 * Runs automated checks immediately.
 */
export async function startClose(
  periodId: string,
  orgId: string,
  userId: string,
  userName: string,
  userRoleCodes: string[],
  tx: Prisma.TransactionClient = prisma
): Promise<CloseSessionResult> {
  // Verify period exists and is in OPEN status
  const period = await tx.financialPeriod.findFirst({
    where: { id: periodId, organizationId: orgId },
    select: { id: true, code: true, name: true, status: true },
  });

  if (!period) {
    throw new Error('Period not found');
  }

  if (period.status !== 'OPEN') {
    throw new Error(`Cannot start close for period with status ${period.status}. Only OPEN periods can be closed.`);
  }

  // Check if a close session already exists
  const existingClose = await tx.financialClose.findUnique({
    where: { periodId },
    select: { id: true, status: true },
  });

  if (existingClose) {
    throw new Error(`Close session already exists for this period (status: ${existingClose.status})`);
  }

  // Create the FinancialClose record
  const close = await tx.financialClose.create({
    data: {
      organizationId: orgId,
      periodId,
      status: 'IN_PROGRESS',
      startedById: userId,
    },
    select: { id: true, periodId: true, status: true },
  });

  // Create all checklist items
  const checklistItems = await Promise.all(
    CHECKLIST_DEFINITIONS.map((def) =>
      tx.closeChecklistItem.create({
        data: {
          organizationId: orgId,
          closeId: close.id,
          itemKey: def.itemKey as any,
          label: def.label,
          isBlocking: def.isBlocking,
          isAutomated: def.isAutomated,
          status: def.isAutomated ? 'IN_PROGRESS' : 'NOT_STARTED',
        },
      })
    )
  );

  // Run automated checks
  const automatedResults = await runAllAutomatedChecks(orgId, periodId);

  // Update checklist items with automated check results
  for (const item of checklistItems) {
    const result = automatedResults[item.itemKey];
    if (result) {
      await tx.closeChecklistItem.update({
        where: { id: item.id },
        data: {
          status: result.passed ? 'PASSED' : 'FAILED',
          computedValue: JSON.stringify({ value: result.value, detail: result.detail }),
        },
      });
    }
  }

  // Update period status to CLOSING
  await tx.financialPeriod.update({
    where: { id: periodId },
    data: { status: 'CLOSING' },
  });

  // Audit log
  await writeAuditEntry(
    tx,
    { id: userId, name: userName, roleCodes: userRoleCodes },
    {
      action: 'FINANCIAL_CLOSE_STARTED',
      entityType: 'FINANCIAL_CLOSE',
      entityId: close.id,
      entityLabel: period.code,
      description: `Started financial close for period ${period.code} (${period.name})`,
      metadata: { periodId, periodCode: period.code },
      result: 'SUCCESS',
      channel: 'WEB',
    },
    { organizationId: orgId }
  );

  // Return updated checklist items
  const updatedItems = await tx.closeChecklistItem.findMany({
    where: { closeId: close.id },
    orderBy: { itemKey: 'asc' },
  });

  return {
    closeId: close.id,
    periodId: close.periodId,
    status: close.status,
    checklistItems: updatedItems.map((item) => ({
      itemKey: item.itemKey,
      label: item.label,
      isBlocking: item.isBlocking,
      isAutomated: item.isAutomated,
      status: item.status,
      computedValue: item.computedValue,
    })),
  };
}

/**
 * Get the current close state for a period.
 */
export async function getCloseState(
  periodId: string,
  orgId: string
): Promise<CloseSessionResult | null> {
  const close = await prisma.financialClose.findFirst({
    where: { periodId, organizationId: orgId },
    include: {
      checklistItems: { orderBy: { itemKey: 'asc' } },
    },
  });

  if (!close) return null;

  return {
    closeId: close.id,
    periodId: close.periodId,
    status: close.status,
    checklistItems: close.checklistItems.map((item) => ({
      itemKey: item.itemKey,
      label: item.label,
      isBlocking: item.isBlocking,
      isAutomated: item.isAutomated,
      status: item.status,
      computedValue: item.computedValue,
    })),
  };
}

/**
 * Confirm a manual checklist item (mark as PASSED).
 */
export async function confirmChecklistItem(
  periodId: string,
  itemKey: string,
  orgId: string,
  userId: string,
  userName: string,
  userRoleCodes: string[],
  tx: Prisma.TransactionClient = prisma
): Promise<ChecklistItemResult> {
  const close = await tx.financialClose.findFirst({
    where: { periodId, organizationId: orgId },
    include: { checklistItems: { where: { itemKey: itemKey as any } } },
  });

  if (!close) throw new Error('Close session not found');
  if (close.checklistItems.length === 0) throw new Error(`Checklist item ${itemKey} not found`);

  const item = close.checklistItems[0]!;

  if (item.isAutomated) {
    throw new Error('Cannot confirm an automated item');
  }

  if (item.status === 'PASSED' || item.status === 'WAIVED') {
    throw new Error(`Item already ${item.status.toLowerCase()}`);
  }

  const updated = await tx.closeChecklistItem.update({
    where: { id: item.id },
    data: {
      status: 'PASSED',
      confirmedById: userId,
      confirmedAt: new Date(),
    },
  });

  await writeAuditEntry(
    tx,
    { id: userId, name: userName, roleCodes: userRoleCodes },
    {
      action: 'FINANCIAL_CLOSE_ITEM_CHECKED',
      entityType: 'CLOSE_CHECKLIST_ITEM',
      entityId: item.id,
      entityLabel: item.itemKey,
      description: `Confirmed checklist item ${item.itemKey} for close ${close.id}`,
      changes: { status: { from: item.status, to: 'PASSED' } },
      result: 'SUCCESS',
      channel: 'WEB',
    },
    { organizationId: orgId }
  );

  return {
    itemKey: updated.itemKey,
    label: updated.label,
    isBlocking: updated.isBlocking,
    isAutomated: updated.isAutomated,
    status: updated.status,
    computedValue: updated.computedValue,
    confirmedById: updated.confirmedById,
    confirmedAt: updated.confirmedAt,
  };
}

/**
 * Waive a checklist item with a reason.
 * Waiver requires approval from the designated waiver approver.
 */
export async function waiveChecklistItem(
  periodId: string,
  itemKey: string,
  orgId: string,
  userId: string,
  userName: string,
  userRoleCodes: string[],
  reason: string,
  waiverApproverId: string,
  tx: Prisma.TransactionClient = prisma
): Promise<ChecklistItemResult> {
  const close = await tx.financialClose.findFirst({
    where: { periodId, organizationId: orgId },
    include: { checklistItems: { where: { itemKey: itemKey as any } } },
  });

  if (!close) throw new Error('Close session not found');
  if (close.checklistItems.length === 0) throw new Error(`Checklist item ${itemKey} not found`);

  const item = close.checklistItems[0]!;

  if (item.isAutomated) {
    throw new Error('Cannot waive an automated item');
  }

  if (item.status === 'PASSED' || item.status === 'WAIVED') {
    throw new Error(`Item already ${item.status.toLowerCase()}`);
  }

  const definition = CHECKLIST_DEFINITIONS.find((d) => d.itemKey === itemKey);
  if (!definition) throw new Error(`Unknown checklist item ${itemKey}`);

  // For blocking items, waiver goes to WAIVED status but requires approval
  // For non-blocking items, waiver is immediate
  const newStatus = definition.isBlocking ? 'WAIVED' : 'WAIVED';

  const updated = await tx.closeChecklistItem.update({
    where: { id: item.id },
    data: {
      status: newStatus,
      waivedById: userId,
      waivedAt: new Date(),
      waiverReason: reason,
      waiverApproverId: definition.isBlocking ? waiverApproverId : null,
      waiverApprovedAt: definition.isBlocking ? null : new Date(),
    },
  });

  await writeAuditEntry(
    tx,
    { id: userId, name: userName, roleCodes: userRoleCodes },
    {
      action: 'FINANCIAL_CLOSE_ITEM_WAIVED',
      entityType: 'CLOSE_CHECKLIST_ITEM',
      entityId: item.id,
      entityLabel: item.itemKey,
      description: `Waived checklist item ${item.itemKey} for close ${close.id}`,
      changes: {
        status: { from: item.status, to: newStatus },
        waiverReason: { from: null, to: reason },
        waiverApproverId: { from: null, to: waiverApproverId },
      },
      metadata: { isBlocking: definition.isBlocking, requiresApproval: definition.isBlocking },
      result: 'SUCCESS',
      channel: 'WEB',
    },
    { organizationId: orgId }
  );

  return {
    itemKey: updated.itemKey,
    label: updated.label,
    isBlocking: updated.isBlocking,
    isAutomated: updated.isAutomated,
    status: updated.status,
    computedValue: updated.computedValue,
    waivedById: updated.waivedById,
    waivedAt: updated.waivedAt,
    waiverReason: updated.waiverReason,
    waiverApproverId: updated.waiverApproverId,
    waiverApprovedAt: updated.waiverApprovedAt,
  };
}

/**
 * Submit the close for CEO sign-off.
 * Creates an approval request for FINANCIAL_CLOSE entity type.
 */
export async function submitCloseForSignOff(
  periodId: string,
  orgId: string,
  userId: string,
  userName: string,
  userRoleCodes: string[],
  tx: Prisma.TransactionClient = prisma
): Promise<{ closeId: string; approvalRequestId: string }> {
  const close = await tx.financialClose.findFirst({
    where: { periodId, organizationId: orgId },
    include: { checklistItems: true },
  });

  if (!close) throw new Error('Close session not found');
  if (close.status !== 'IN_PROGRESS') {
    throw new Error(`Close is not in progress (status: ${close.status})`);
  }

  // Check all blocking items are PASSED or WAIVED
  const blockingItems = close.checklistItems.filter((item) => item.isBlocking);
  const failedBlocking = blockingItems.filter((item) => item.status === 'FAILED');
  if (failedBlocking.length > 0) {
    throw new Error(`${failedBlocking.length} blocking item(s) are still failing. Cannot submit.`);
  }

  // Check all items have a status (not NOT_STARTED for manual items)
  const notStarted = close.checklistItems.filter(
    (item) => !item.isAutomated && item.status === 'NOT_STARTED'
  );
  if (notStarted.length > 0) {
    throw new Error(`${notStarted.length} manual item(s) not yet confirmed.`);
  }

  // Create approval request for CEO sign-off
  const approvalRequest = await createApprovalRequest(
    {
      organizationId: orgId,
      entityType: 'FINANCIAL_CLOSE',
      entityId: close.id,
      amount: 0,
      currencyCode: 'TZS',
      submittedById: userId,
      context: {
        organizationId: orgId,
        entityType: 'FINANCIAL_CLOSE',
        entityId: close.id,
        submittedById: userId,
        amount: 0,
        currencyCode: 'TZS',
      },
    },
    tx
  );

  // Update close record
  await tx.financialClose.update({
    where: { id: close.id },
    data: {
      status: 'SUBMITTED',
      submittedById: userId,
      submittedAt: new Date(),
      approvalRequestId: approvalRequest.id,
    },
  });

  await writeAuditEntry(
    tx,
    { id: userId, name: userName, roleCodes: userRoleCodes },
    {
      action: 'FINANCIAL_CLOSE_SUBMITTED',
      entityType: 'FINANCIAL_CLOSE',
      entityId: close.id,
      entityLabel: close.id,
      description: `Submitted financial close ${close.id} for CEO sign-off`,
      changes: { status: { from: 'IN_PROGRESS', to: 'SUBMITTED' } },
      metadata: { approvalRequestId: approvalRequest.id },
      result: 'SUCCESS',
      channel: 'WEB',
    },
    { organizationId: orgId }
  );

  return { closeId: close.id, approvalRequestId: approvalRequest.id };
}

/**
 * CEO signs off on the close (approves the approval request).
 * This is called by the approval engine when the CEO approves.
 */
export async function signOffClose(
  periodId: string,
  orgId: string,
  userId: string, // CEO user ID
  userName: string,
  userRoleCodes: string[],
  tx: Prisma.TransactionClient = prisma
): Promise<{ closeId: string; periodStatus: string }> {
  const close = await tx.financialClose.findFirst({
    where: { periodId, organizationId: orgId },
    include: { checklistItems: true },
  });

  if (!close) throw new Error('Close session not found');
  if (close.status !== 'SUBMITTED') {
    throw new Error(`Close is not submitted for sign-off (status: ${close.status})`);
  }
  if (!close.approvalRequestId) {
    throw new Error('No approval request associated with this close');
  }

  // Verify the approval request is approved
  const approvalRequest = await tx.approvalRequest.findUnique({
    where: { id: close.approvalRequestId },
    select: { id: true, status: true },
  });

  if (!approvalRequest || approvalRequest.status !== 'APPROVED') {
    throw new Error('Approval request is not approved');
  }

  // Update close record
  const updatedClose = await tx.financialClose.update({
    where: { id: close.id },
    data: {
      status: 'SIGNED_OFF',
      signedOffById: userId,
      signedOffAt: new Date(),
    },
  });

  // Update period status to LOCKED
  const updatedPeriod = await tx.financialPeriod.update({
    where: { id: periodId },
    data: { status: 'LOCKED', lockedAt: new Date() },
  });

  await writeAuditEntry(
    tx,
    { id: userId, name: userName, roleCodes: userRoleCodes },
    {
      action: 'FINANCIAL_CLOSE_SIGNED_OFF',
      entityType: 'FINANCIAL_CLOSE',
      entityId: close.id,
      entityLabel: close.id,
      description: `CEO signed off financial close ${close.id}`,
      changes: {
        closeStatus: { from: 'SUBMITTED', to: 'SIGNED_OFF' },
        periodStatus: { from: 'CLOSING', to: 'LOCKED' },
      },
      metadata: { approvalRequestId: close.approvalRequestId },
      result: 'SUCCESS',
      channel: 'WEB',
    },
    { organizationId: orgId }
  );

  return { closeId: close.id, periodStatus: updatedPeriod.status };
}

/**
 * Generate close report (JSON summary).
 */
export async function generateCloseReport(
  periodId: string,
  orgId: string
): Promise<{
  period: { id: string; code: string; name: string; status: string };
  close: { id: string; status: string; startedAt: Date; submittedAt?: Date | null; signedOffAt?: Date | null };
  checklistItems: Array<{
    itemKey: string;
    label: string;
    isBlocking: boolean;
    isAutomated: boolean;
    status: string;
    computedValue?: string | null;
    confirmedById?: string | null;
    confirmedAt?: Date | null;
    waivedById?: string | null;
    waivedAt?: Date | null;
    waiverReason?: string | null;
    waiverApproverId?: string | null;
    waiverApprovedAt?: Date | null;
  }>;
  summary: {
    totalItems: number;
    passedItems: number;
    failedItems: number;
    waivedItems: number;
    blockingFailed: number;
    blockingWaived: number;
    canSubmit: boolean;
    canSignOff: boolean;
  };
}> {
  const period = await prisma.financialPeriod.findFirst({
    where: { id: periodId, organizationId: orgId },
    select: { id: true, code: true, name: true, status: true },
  });

  if (!period) throw new Error('Period not found');

  const close = await prisma.financialClose.findFirst({
    where: { periodId, organizationId: orgId },
    include: { checklistItems: { orderBy: { itemKey: 'asc' } } },
  });

  if (!close) throw new Error('Close session not found');

  const items = close.checklistItems;
  const totalItems = items.length;
  const passedItems = items.filter((i) => i.status === 'PASSED').length;
  const failedItems = items.filter((i) => i.status === 'FAILED').length;
  const waivedItems = items.filter((i) => i.status === 'WAIVED').length;
  const blockingFailed = items.filter((i) => i.isBlocking && i.status === 'FAILED').length;
  const blockingWaived = items.filter((i) => i.isBlocking && i.status === 'WAIVED').length;

  const canSubmit = close.status === 'IN_PROGRESS' && blockingFailed === 0 && items.every((i) => i.isAutomated || i.status !== 'NOT_STARTED');
  const canSignOff = close.status === 'SUBMITTED';

  return {
    period: { id: period.id, code: period.code, name: period.name, status: period.status },
    close: {
      id: close.id,
      status: close.status,
      startedAt: close.startedAt,
      submittedAt: close.submittedAt,
      signedOffAt: close.signedOffAt,
    },
    checklistItems: items.map((item) => ({
      itemKey: item.itemKey,
      label: item.label,
      isBlocking: item.isBlocking,
      isAutomated: item.isAutomated,
      status: item.status,
      computedValue: item.computedValue,
      confirmedById: item.confirmedById,
      confirmedAt: item.confirmedAt,
      waivedById: item.waivedById,
      waivedAt: item.waivedAt,
      waiverReason: item.waiverReason,
      waiverApproverId: item.waiverApproverId,
      waiverApprovedAt: item.waiverApprovedAt,
    })),
    summary: {
      totalItems,
      passedItems,
      failedItems,
      waivedItems,
      blockingFailed,
      blockingWaived,
      canSubmit,
      canSignOff,
    },
  };
}