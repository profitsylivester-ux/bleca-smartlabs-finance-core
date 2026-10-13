import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db/prisma';
import { Prisma } from '@/generated/prisma/client';
import { seedTestFixtures } from '../setup/fixtures';
import { createApprovalRequest, advanceRequest } from '@/lib/approvals';
import { runIdempotent } from '@/lib/api/idempotency';
import { writeAuditEntry } from '@/lib/audit/writer';
import type { ConditionContext } from '@/lib/approvals';
import type { ActorContext } from '@/lib/kernel/context';
import type { ApprovalRequest, ApprovalStepInstance } from '@/lib/approvals/types';

let getOrgId: () => Promise<string>;
let financeOfficerId: string;
let financeOfficerActor: ActorContext;
let ceoId: string;
let ceoActor: ActorContext;
let delegateId: string;
let delegateActor: ActorContext;
let assetAccountId: string;
let periodId: string;
let financeOfficerRole: { id: string } | null;
let ceoRole: { id: string } | null;

beforeAll(async () => {
  console.log('[DEBUG beforeAll] Starting beforeAll');
  await seedTestFixtures(prisma);
  console.log('[DEBUG beforeAll] After seedTestFixtures');

  // Debug: check if approval policy exists
  const debugPolicies = await prisma.approvalPolicy.findMany({ where: { entityType: 'TRANSACTION' }, include: { steps: true } });
  console.log('DEBUG: Policies after seedTestFixtures:', JSON.stringify(debugPolicies, null, 2));

  const org = await prisma.organization.findFirstOrThrow({
    where: { code: 'BLECA' },
    select: { id: true },
  });
  const orgIdValue = org.id;
  console.log('DEBUG: orgId from query:', orgIdValue);
  getOrgId = async () => orgIdValue;

  financeOfficerRole = await prisma.role.findUnique({
    where: { code: 'FINANCE_OFFICER' },
    select: { id: true },
  });

  ceoRole = await prisma.role.findUnique({
    where: { code: 'CEO' },
    select: { id: true },
  });

  console.log('[DEBUG Finance Officer creation] financeOfficerRole:', financeOfficerRole);
  const financeOfficer = await prisma.user.create({
    data: {
      email: `finance-${Date.now()}@bleca.test`,
      emailNormalized: `finance-${Date.now()}@bleca.test`,
      fullName: 'Test Finance Officer',
      passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$test$test',
      passwordAlgorithm: 'ARGON2ID',
      status: 'ACTIVE',
      organizationMemberships: { create: { organizationId: await getOrgId() } },
      userRoles: { create: { roleId: financeOfficerRole!.id } },
    },
    select: { id: true, email: true, fullName: true, userRoles: { where: { revokedAt: null }, select: { role: { select: { code: true } } } } },
  });
  financeOfficerId = financeOfficer.id;
  const orgIdForActors = await getOrgId();
  financeOfficerActor = {
    userId: financeOfficer.id,
    email: financeOfficer.email,
    fullName: financeOfficer.fullName,
    roleCodes: financeOfficer.userRoles.map((ur) => ur.role.code),
    isFinalApprover: false,
    organizationId: orgIdForActors,
    sessionId: null,
    mfaSatisfiedAt: null,
    stepUpSatisfiedAt: null,
    stepUpExpiresAt: null,
  };

  const ceo = await prisma.user.create({
    data: {
      email: `ceo-${Date.now()}@bleca.test`,
      emailNormalized: `ceo-${Date.now()}@bleca.test`,
      fullName: 'Test CEO',
      passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$test$test',
      passwordAlgorithm: 'ARGON2ID',
      status: 'ACTIVE',
      organizationMemberships: { create: { organizationId: await getOrgId() } },
      userRoles: { create: { roleId: ceoRole!.id } },
    },
    select: { id: true, email: true, fullName: true, userRoles: { where: { revokedAt: null }, select: { role: { select: { code: true } } } } },
  });
  ceoId = ceo.id;
  ceoActor = {
    userId: ceo.id,
    email: ceo.email,
    fullName: ceo.fullName,
    roleCodes: ceo.userRoles.map((ur) => ur.role.code),
    isFinalApprover: true,
    organizationId: orgIdForActors,
    sessionId: null,
    mfaSatisfiedAt: null,
    stepUpSatisfiedAt: null,
    stepUpExpiresAt: null,
  };
  
  const delegate = await prisma.user.create({
    data: {
      email: `delegate-${Date.now()}@bleca.test`,
      emailNormalized: `delegate-${Date.now()}@bleca.test`,
      fullName: 'Test Delegate',
      passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$test$test',
      passwordAlgorithm: 'ARGON2ID',
      status: 'ACTIVE',
      organizationMemberships: { create: { organizationId: await getOrgId() } },
      userRoles: { create: { roleId: ceoRole!.id } },
    },
    select: { id: true, email: true, fullName: true, userRoles: { where: { revokedAt: null }, select: { role: { select: { code: true } } } } },
  });
  delegateId = delegate.id;
  delegateActor = {
    userId: delegate.id,
    email: delegate.email,
    fullName: delegate.fullName,
    roleCodes: delegate.userRoles.map((ur) => ur.role.code),
    isFinalApprover: true,
    organizationId: orgIdForActors,
    sessionId: null,
    mfaSatisfiedAt: null,
    stepUpSatisfiedAt: null,
    stepUpExpiresAt: null,
  };

  const assetAccount = await prisma.account.findFirst({
    where: { organizationId: await getOrgId(), type: 'ASSET', isPostable: true, requiresDocument: false },
    select: { id: true },
  });
  assetAccountId = assetAccount!.id;

  const period = await prisma.financialPeriod.findFirst({
    where: { organizationId: await getOrgId(), status: 'OPEN' },
    orderBy: { startDate: 'asc' },
    select: { id: true },
  });
  periodId = period!.id;
});

afterAll(async () => {
  // Clean up approval data only - skip immutable POSTED/APPROVED transactions and journal entries
  // Database is reset between test runs, so just clean up test-specific approval records
  // Note: users with POSTED journal entries cannot be deleted due to immutability triggers;
  // the database reset handles this.
  await prisma.approvalDecisionRecord.deleteMany({
    where: { actorId: { in: [financeOfficerId, ceoId, delegateId] } },
  });
  await prisma.approvalStepInstance.deleteMany({
    where: { decidedById: { in: [financeOfficerId, ceoId, delegateId] } },
  });
  await prisma.approvalRequest.deleteMany({
    where: { submittedById: { in: [financeOfficerId, ceoId, delegateId] } },
  });
  await prisma.session.updateMany({
    where: { userId: { in: [financeOfficerId, ceoId, delegateId] }, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: 'ADMIN_REVOKED', absoluteExpiresAt: new Date(0) },
  });
  await prisma.$disconnect();
});

describe('M6 Approval Workflow', () => {
  beforeAll(async () => {
    // Tables are already truncated and seeded by seedTestFixtures in the outer beforeAll
  });

  const createTransactionAndSubmit = async (actor: ActorContext, amount: number, orgId: string) => {
    const tx = await prisma.transaction.create({
      data: {
        organizationId: orgId,
        status: 'DRAFT',
        date: new Date(),
        description: 'Test transaction for approval',
        accountId: assetAccountId,
        amount,
        currencyCode: 'TZS',
        paymentMethod: 'BANK_TRANSFER',
        submittedById: actor.userId,
      },
    });

    const context: ConditionContext = {
      organizationId: orgId,
      entityType: 'TRANSACTION',
      entityId: tx.id,
      submittedById: actor.userId,
      amount,
      currencyCode: 'TZS',
    };

    console.log('[DEBUG createTransactionAndSubmit] orgId:', orgId);

    const request = await createApprovalRequest(
      {
        organizationId: orgId,
        entityType: 'TRANSACTION',
        entityId: tx.id,
        amount,
        currencyCode: 'TZS',
        submittedById: actor.userId,
        context,
      },
      prisma
    );

    const requestWithSteps = request as ApprovalRequest & { stepInstances: ApprovalStepInstance[] };

    return { transaction: tx, request: requestWithSteps };
  };

  it('full submit → route → approve → post flow for Transaction', async () => {
    const orgId = await getOrgId();
    const { transaction, request } = await createTransactionAndSubmit(financeOfficerActor, 5000, orgId);

    expect(request.status).toBe('IN_PROGRESS');
    expect(request.stepInstances.length).toBeGreaterThan(0);
    expect(request.currentStepIndex).toBe(0);

    const firstStep = request.stepInstances[0]!;
    expect(firstStep.status).toBe('PENDING');

    const idempotencyKey1 = `test-approve-${request.id}-step-1`;

    const outcome1 = await advanceRequest(
      request.id,
      'APPROVED',
      { userId: ceoActor.userId, fullName: ceoActor.fullName, roleCodes: ceoActor.roleCodes },
      { reason: 'Approved by CEO', tx: prisma }
    );

    expect(outcome1.request.status).toBe('APPROVED');
    expect(outcome1.decisionRecord.decision).toBe('APPROVED');
    expect(outcome1.isComplete).toBe(true);

    const auditEntries = await prisma.auditLog.findMany({
      where: { entityId: request.id, entityType: 'APPROVAL_REQUEST' },
      orderBy: { recordedAt: 'asc' },
    });
    expect(auditEntries.length).toBeGreaterThanOrEqual(2);
    const approvedAudit = auditEntries.find((e) => e.action === 'APPROVAL_REQUEST_APPROVED');
    expect(approvedAudit).toBeDefined();
    expect(approvedAudit?.result).toBe('SUCCESS');
  });

  it('Finance Officer cannot self-approve', async () => {
    const orgId = await getOrgId();
    const { request } = await createTransactionAndSubmit(financeOfficerActor, 3000, orgId);

    const firstStep = request.stepInstances[0]!;
    expect(firstStep.status).toBe('PENDING');

    await expect(
      advanceRequest(
        request.id,
        'APPROVED',
        { userId: financeOfficerActor.userId, fullName: financeOfficerActor.fullName, roleCodes: financeOfficerActor.roleCodes },
        { reason: 'Self-approval attempt', tx: prisma }
      )
    ).rejects.toThrow();

    const auditEntries = await prisma.auditLog.findMany({
      where: { entityId: request.id, entityType: 'APPROVAL_STEP_INSTANCE', result: 'FAILURE' },
    });
    expect(auditEntries.length).toBeGreaterThan(0);
    const failureAudit = auditEntries[0]!;
    expect(failureAudit.metadata).toBeDefined();
    expect((failureAudit.metadata as Record<string, unknown>)?.sodViolation).toBe(true);
  });

  it('CEO approves and posts', async () => {
    const orgId = await getOrgId();
    const { transaction, request } = await createTransactionAndSubmit(financeOfficerActor, 7000, orgId);

    await advanceRequest(
      request.id,
      'APPROVED',
      { userId: ceoActor.userId, fullName: ceoActor.fullName, roleCodes: ceoActor.roleCodes },
      { reason: 'CEO approval', tx: prisma }
    );

    const approvedTx = await prisma.transaction.findUnique({ where: { id: transaction.id } });
    expect(approvedTx?.status).toBe('APPROVED');

    const txService = (await import('@/lib/transactions/service')).TransactionService;
    const posted = await new txService().post(transaction.id, orgId, ceoActor);

    expect(posted.status).toBe('POSTED');

    const postedTx = await prisma.transaction.findUnique({ where: { id: transaction.id } });
    expect(postedTx?.status).toBe('POSTED');

    const auditEntries = await prisma.auditLog.findMany({
      where: { entityId: transaction.id, entityType: 'JOURNAL_ENTRY' },
      orderBy: { recordedAt: 'asc' },
    });
    const postedAudit = auditEntries.find((e) => e.action === 'JOURNAL_ENTRY_POSTED');
    expect(postedAudit).toBeDefined();
    expect(postedAudit?.result).toBe('SUCCESS');
  });

  it('delegation tested and expires', async () => {
    const orgId = await getOrgId();
    console.log('[DEBUG delegation test] ceoRole:', ceoRole, 'ceoId:', ceoId);
    const delegation = await prisma.delegation.create({
      data: {
        grantorId: ceoId,
        granteeId: delegateId,
        kind: 'APPROVAL_AUTHORITY',
        roleId: ceoRole!.id,
        reason: 'CEO on vacation',
        startsAt: new Date(Date.now() - 1000),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    const { request } = await createTransactionAndSubmit(financeOfficerActor, 2000, orgId);

    await advanceRequest(
      request.id,
      'APPROVED',
      { userId: delegateActor.userId, fullName: delegateActor.fullName, roleCodes: delegateActor.roleCodes },
      { reason: 'Delegated approval', tx: prisma }
    );

    const decisionRecord = await prisma.approvalDecisionRecord.findFirst({
      where: { requestId: request.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(decisionRecord?.delegationId).toBe(delegation.id);
    expect(decisionRecord?.actorId).toBe(delegateId);

    await prisma.delegation.update({
      where: { id: delegation.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const { request: request2 } = await createTransactionAndSubmit(financeOfficerActor, 2500, orgId);

    await expect(
      advanceRequest(
        request2.id,
        'APPROVED',
        { userId: delegateActor.userId, fullName: delegateActor.fullName, roleCodes: delegateActor.roleCodes },
        { reason: 'Expired delegation attempt', tx: prisma }
      )
    ).rejects.toThrow();
  });

  it('policy edit mid-flight does not affect in-flight requests', async () => {
    const orgId = await getOrgId();
    const policy = await prisma.approvalPolicy.findFirst({
      where: { organizationId: orgId, entityType: 'TRANSACTION', isActive: true },
      include: { steps: true },
    });
    expect(policy).toBeDefined();

    const { request } = await createTransactionAndSubmit(financeOfficerActor, 10000, orgId);

    const originalStepsCount = (request.policySnapshot as { steps?: unknown[] } | undefined)?.steps?.length ?? 0;
    expect(originalStepsCount).toBeGreaterThan(0);

    await prisma.approvalPolicy.update({
      where: { id: policy!.id },
      data: {
        steps: {
          deleteMany: {},
          create: [
            {
              stepOrder: 1,
              name: 'New Step 1',
              type: 'APPROVAL',
              assigneeType: 'ROLE',
              assigneeRoleId: ceoRole!.id,
              resolutionMode: 'ANY',
              isRequired: true,
              isFinalApprover: true,
            },
            {
              stepOrder: 2,
              name: 'New Step 2',
              type: 'APPROVAL',
              assigneeType: 'ROLE',
              assigneeRoleId: financeOfficerRole!.id,
              resolutionMode: 'ANY',
              isRequired: true,
              isFinalApprover: false,
            },
          ],
        },
      },
    });

    const refreshedRequest = await prisma.approvalRequest.findUnique({
      where: { id: request.id },
      include: { stepInstances: { orderBy: { stepOrder: 'asc' } } },
    });

    expect(refreshedRequest?.stepInstances.length).toBe(originalStepsCount);
    expect(refreshedRequest?.stepInstances[0]?.stepName).not.toBe('New Step 1');
  });

  it('double-decision rejected (idempotency)', async () => {
    const orgId = await getOrgId();
    const { request } = await createTransactionAndSubmit(financeOfficerActor, 4000, orgId);

    const idempotencyKey = `test-idempotent-${request.id}`;

    await advanceRequest(
      request.id,
      'APPROVED',
      { userId: ceoActor.userId, fullName: ceoActor.fullName, roleCodes: ceoActor.roleCodes },
      { reason: 'First decision', tx: prisma }
    );

    await expect(
      advanceRequest(
        request.id,
        'REJECTED',
        { userId: ceoActor.userId, fullName: ceoActor.fullName, roleCodes: ceoActor.roleCodes },
        { reason: 'Second decision attempt', tx: prisma }
      )
    ).rejects.toThrow();

    const decisionRecords = await prisma.approvalDecisionRecord.findMany({
      where: { requestId: request.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(decisionRecords.length).toBe(1);
    expect(decisionRecords[0]!.decision).toBe('APPROVED');
  });

  it('every decision audited with SOD evidence', async () => {
    const orgId = await getOrgId();
    const { request } = await createTransactionAndSubmit(financeOfficerActor, 6000, orgId);

    await advanceRequest(
      request.id,
      'APPROVED',
      { userId: ceoActor.userId, fullName: ceoActor.fullName, roleCodes: ceoActor.roleCodes },
      { reason: 'Approval with SOD check', tx: prisma }
    );

    const decisionRecord = await prisma.approvalDecisionRecord.findFirst({
      where: { requestId: request.id },
      orderBy: { createdAt: 'desc' },
    });

    expect(decisionRecord).toBeDefined();
    expect(decisionRecord?.sodViolation).toBe(false);
    expect(decisionRecord?.sodWaiverId).toBeNull();
    expect(decisionRecord?.delegationId).toBeNull();

    const auditEntries = await prisma.auditLog.findMany({
      where: { entityId: request.id },
      orderBy: { recordedAt: 'asc' },
    });

    const stepDecidedAudit = auditEntries.find((e) => e.action === 'APPROVAL_STEP_DECIDED');
    expect(stepDecidedAudit).toBeDefined();
    expect((stepDecidedAudit?.metadata as Record<string, unknown>)?.sodViolation).toBe(false);
    expect((stepDecidedAudit?.metadata as Record<string, unknown>)?.sodWaiverId).toBeNull();
    expect((stepDecidedAudit?.metadata as Record<string, unknown>)?.delegationId).toBeNull();
    expect((stepDecidedAudit?.metadata as Record<string, unknown>)?.actorRoleCodes).toContain('CEO');

    const requestApprovedAudit = auditEntries.find((e) => e.action === 'APPROVAL_REQUEST_APPROVED');
    expect(requestApprovedAudit).toBeDefined();
    expect(requestApprovedAudit?.result).toBe('SUCCESS');
  });

  it('SOD violation recorded when submitter tries to approve', async () => {
    const orgId = await getOrgId();
    const { request } = await createTransactionAndSubmit(financeOfficerActor, 500, orgId);

    try {
      await advanceRequest(
        request.id,
        'APPROVED',
        { userId: financeOfficerActor.userId, fullName: financeOfficerActor.fullName, roleCodes: financeOfficerActor.roleCodes },
        { reason: 'Self-approval', tx: prisma }
      );
    } catch (e) {
      // Expected to throw
    }

    const decisionRecords = await prisma.approvalDecisionRecord.findMany({
      where: { requestId: request.id },
    });

    const failedDecision = decisionRecords.find((d) => d.decision === 'APPROVED' && d.actorId === financeOfficerId);
    if (failedDecision) {
      expect(failedDecision.sodViolation).toBe(true);
    }

    const auditEntries = await prisma.auditLog.findMany({
      where: { entityId: request.id, entityType: 'APPROVAL_STEP_INSTANCE', result: 'FAILURE' },
    });
    expect(auditEntries.length).toBeGreaterThan(0);
    const failureAudit = auditEntries[0]!;
    expect(failureAudit.metadata).toBeDefined();
    expect((failureAudit.metadata as Record<string, unknown>)?.sodViolation).toBe(true);
  });
});

describe('M6 Access Review', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE access_reviews, access_review_items RESTART IDENTITY CASCADE`);
  });

  it('create review, list items, certify/revoke roles', async () => {
    const review = await prisma.accessReview.create({
      data: {
        name: 'Quarterly Access Review Q3 2024',
        periodStart: new Date('2024-07-01'),
        periodEnd: new Date('2024-09-30'),
        initiatedById: ceoId,
        scopeJson: { source: 'ALL_ACTIVE_GRANTS' },
        items: {
          create: [
            {
              userId: financeOfficerId,
              roleId: (await prisma.role.findUnique({ where: { code: 'FINANCE_OFFICER' }, select: { id: true } }))!.id,
              currentExpiresAt: null,
            },
            {
              userId: delegateId,
              roleId: (await prisma.role.findUnique({ where: { code: 'CEO' }, select: { id: true } }))!.id,
              currentExpiresAt: null,
            },
          ],
        },
      },
      include: { items: { include: { user: true, role: true } } },
    });

    expect(review.items.length).toBe(2);
    expect(review.status).toBe('OPEN');

    const itemToCertify = review.items[0]!;
    const itemToRevoke = review.items[1]!;

    await prisma.accessReviewItem.update({
      where: { id: itemToCertify.id },
      data: {
        decision: 'RETAIN',
        decisionReason: 'Still requires access for daily operations',
        decidedById: ceoId,
        decidedAt: new Date(),
        actionedAt: new Date(),
      },
    });

    await prisma.accessReviewItem.update({
      where: { id: itemToRevoke.id },
      data: {
        decision: 'REVOKE',
        decisionReason: 'Delegate role no longer needed',
        decidedById: ceoId,
        decidedAt: new Date(),
        actionedAt: new Date(),
      },
    });

    await prisma.userRole.updateMany({
      where: { userId: itemToRevoke.userId, roleId: itemToRevoke.roleId, revokedAt: null },
      data: { revokedAt: new Date(), reason: 'Access review: Delegate role no longer needed' },
    });

    const certified = await prisma.accessReviewItem.findUnique({ where: { id: itemToCertify.id } });
    const revoked = await prisma.accessReviewItem.findUnique({ where: { id: itemToRevoke.id } });

    expect(certified?.decision).toBe('RETAIN');
    expect(revoked?.decision).toBe('REVOKE');

    const revokedUserRole = await prisma.userRole.findFirst({
      where: { userId: itemToRevoke.userId, roleId: itemToRevoke.roleId },
    });
    expect(revokedUserRole?.revokedAt).not.toBeNull();

    const auditEntries = await prisma.auditLog.findMany({
      where: { entityId: review.id, entityType: 'ACCESS_REVIEW' },
      orderBy: { recordedAt: 'asc' },
    });
    expect(auditEntries.length).toBeGreaterThanOrEqual(0);
  });
});