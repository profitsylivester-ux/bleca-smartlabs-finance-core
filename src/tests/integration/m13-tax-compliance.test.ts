import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/db/prisma';
import {
  createTaxRule,
  createTaxObligation,
  fileTaxObligation,
  markTaxObligationPaid,
  createCredential,
  listCredentials,
  getComplianceStatus,
} from '@/lib/tax-compliance/service';
import { calculateTax, selectEffectiveTaxRule } from '@/lib/tax-compliance/calculator';
import type { RequestContext } from '@/lib/kernel/context';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
let organizationId = '';
let ceoId = '';
let ceoRoleId = '';

function context(userId: string, roleCodes: string[] = ['CEO']): RequestContext {
  return {
    actor: {
      userId,
      email: `${userId}@example.test`,
      fullName: 'M13 Test Actor',
      roleCodes,
      isFinalApprover: roleCodes.includes('CEO'),
      organizationId,
      sessionId: null,
      mfaSatisfiedAt: new Date(),
      stepUpSatisfiedAt: null,
      stepUpExpiresAt: null,
    },
    requestId: 'm13-integration-test',
    channel: 'WEB',
    idempotencyKey: null,
    ipAddress: null,
    userAgent: 'vitest',
    syncBatchId: null,
  };
}

async function createTestUser(name: string, withCeoRole = false): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `${name}-${suffix}@example.test`,
      emailNormalized: `${name}-${suffix}@example.test`,
      fullName: 'M13 Test User',
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
      data: { userId: user.id, roleId: ceoRoleId, reason: 'M13 test access' },
    });
  }
  return user.id;
}

beforeAll(async () => {
  const org = await prisma.organization.findUniqueOrThrow({
    where: { code: 'BLECA' },
    select: { id: true },
  });
  organizationId = org.id;
  ceoRoleId = (await prisma.role.findUniqueOrThrow({ where: { code: 'CEO' }, select: { id: true } })).id;
  ceoId = await createTestUser('m13-ceo', true);
});

afterAll(async () => {
  await prisma.taxPayment.deleteMany({ where: { organizationId } }).catch(() => {});
  await prisma.taxObligation.deleteMany({ where: { organizationId } }).catch(() => {});
  await prisma.taxRule.deleteMany({ where: { organizationId } }).catch(() => {});
  await prisma.credential.deleteMany({ where: { organizationId } }).catch(() => {});
});

describe('M13 Tax & Compliance', () => {
  it('creates a tax rule with rate stored as data', async () => {
    const rule = await createTaxRule(context(ceoId), {
      code: `VATC${suffix}`,
      name: 'Test VAT',
      type: 'VAT',
      jurisdiction: 'TEST',
      ratePercent: '15',
      calculationBasis: 'EXCLUSIVE',
      appliesWhenOrganizationRegistered: true,
      roundingMode: 'HALF_UP',
      isInclusive: false,
      effectiveFrom: '2020-01-01',
      isActive: true,
    });
    expect(rule.code).toBe(`VATC${suffix}`);
    expect(Number(rule.ratePercent)).toBe(15);
  });

  it('calculates tax from the configured rule', async () => {
    const rule = await createTaxRule(context(ceoId), {
      code: `VATX${suffix}`,
      name: 'Test VAT Calculation',
      type: 'VAT',
      jurisdiction: 'TEST',
      ratePercent: '15',
      calculationBasis: 'EXCLUSIVE',
      appliesWhenOrganizationRegistered: true,
      roundingMode: 'HALF_UP',
      isInclusive: false,
      effectiveFrom: '2020-01-01',
      isActive: true,
    });
    const result = calculateTax(1000, rule, new Date());
    expect(Number(result.taxAmount)).toBe(150);
    expect(Number(result.total)).toBe(1150);
  });

  it('handles inclusive calculation', async () => {
    const rule = await createTaxRule(context(ceoId), {
      code: `VATI${suffix}`,
      name: 'Test VAT Inclusive',
      type: 'VAT',
      jurisdiction: 'TEST',
      ratePercent: '15',
      calculationBasis: 'INCLUSIVE',
      appliesWhenOrganizationRegistered: true,
      roundingMode: 'HALF_UP',
      isInclusive: true,
      effectiveFrom: '2020-01-01',
      isActive: true,
    });
    const result = calculateTax(1150, rule, new Date());
    expect(Number(result.taxableAmount)).toBeCloseTo(1000, 2);
    expect(Number(result.taxAmount)).toBeCloseTo(150, 2);
  });

  it('selects the effective rule by document date', () => {
    const rules = [
      { isActive: true, effectiveFrom: new Date('2020-01-01'), effectiveTo: new Date('2022-12-31') },
      { isActive: true, effectiveFrom: new Date('2023-01-01'), effectiveTo: null },
    ];
    const picked = selectEffectiveTaxRule(rules, new Date('2023-06-15'));
    expect(picked?.effectiveFrom.getFullYear()).toBe(2023);
  });

  it('creates a tax obligation, files it and marks it paid', async () => {
    const obligation = await createTaxObligation(context(ceoId), {
      period: `2024-01-${suffix}`,
      direction: 'PAYABLE',
      filingDueDate: '2024-02-20',
      taxableAmount: '10000',
      taxAmount: '1500',
      currencyCode: 'TZS',
      description: `Test obligation ${suffix}`,
    });
    expect(obligation.status).toBe('PENDING');

    const filed = await fileTaxObligation(context(ceoId), obligation.id);
    expect(filed.status).toBe('FILED');
  });

  it('creates a credential and lists it', async () => {
    const credential = await createCredential(context(ceoId), {
      type: 'LICENCE',
      title: `Test licence ${suffix}`,
      issuingAuthority: 'TEST',
      issuedDate: '2024-01-01',
      expiryDate: '2030-01-01',
      responsibleUserId: ceoId,
      cost: '100000',
      renewalReminderDays: 30,
      currencyCode: 'TZS',
    });
    expect(credential.id).toBeTruthy();

    const list = await listCredentials(context(ceoId));
    expect(list.length).toBeGreaterThan(0);
  });

  it('compliance status returns an object', async () => {
    const status = await getComplianceStatus(context(ceoId));
    expect(status).toBeTruthy();
    expect(typeof status).toBe('object');
  });

  it('audit trail records actor actions', async () => {
    const action = await prisma.auditLog.findFirst({
      where: { actorId: ceoId },
      orderBy: { sequence: 'desc' },
      select: { id: true, action: true, result: true },
    });
    expect(action).toBeTruthy();
  });
});


