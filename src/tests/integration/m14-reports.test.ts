import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/db/prisma';
import { computeReport } from '@/lib/reports/engine';
import { reportDefinition } from '@/lib/reports/registry';
import type { RequestContext } from '@/lib/kernel/context';
import { NextRequest } from 'next/server';
import { seedTestFixtures } from '../setup/fixtures';

vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

const { mockRequireContext, mockRequestId } = vi.hoisted(() => ({
  mockRequireContext: vi.fn(),
  mockRequestId: vi.fn(async () => 'm14-integration-test'),
}));

vi.mock('@/lib/auth/guard', () => ({ requireContext: mockRequireContext }));
vi.mock('@/lib/api/responses', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/responses')>();
  return { ...actual, requestId: mockRequestId };
});

import { GET as exportGet } from '@/app/api/v1/reports/[reportKey]/export/route';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
let organizationId = '';
let ceoId = '';
let ceoRoleId = '';
let viewerId = '';
let accountantId = '';

function context(userId: string, roleCodes: string[] = []): RequestContext {
  return {
    actor: {
      userId,
      email: `${userId}@example.test`,
      fullName: 'M14 Integration Actor',
      roleCodes,
      isFinalApprover: roleCodes.includes('CEO'),
      organizationId,
      sessionId: null,
      mfaSatisfiedAt: new Date(),
      stepUpSatisfiedAt: null,
      stepUpExpiresAt: null,
    },
    requestId: 'm14-integration-test',
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
      fullName: 'M14 Test User',
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
      data: { userId: user.id, roleId: ceoRoleId, reason: 'M14 integration access' },
    });
  }
  return user.id;
}

beforeAll(async () => {
  // Re-seed to pick up new EXPORTS permissions
  await seedTestFixtures(prisma);
  const org = await prisma.organization.findUniqueOrThrow({
    where: { code: 'BLECA' },
    select: { id: true },
  });
  organizationId = org.id;
  ceoRoleId = (await prisma.role.findUniqueOrThrow({ where: { code: 'CEO' }, select: { id: true } })).id;
  // Ensure CEO role has EXPORTS:EXPORT permission
  const exportPerm = await prisma.permission.findFirst({
    where: { module: 'EXPORTS', action: 'EXPORT' },
    select: { id: true },
  });
  if (exportPerm) {
    const existing = await prisma.rolePermission.findFirst({
      where: { roleId: ceoRoleId, permissionId: exportPerm.id },
    });
    if (!existing) {
      await prisma.rolePermission.create({
        data: { roleId: ceoRoleId, permissionId: exportPerm.id },
      });
    }
  }
  ceoId = await createTestUser('m14-ceo', true);
  viewerId = await createTestUser('m14-viewer');
  accountantId = await createTestUser('m14-accountant');
  mockRequireContext.mockResolvedValue(context(ceoId, ['CEO']));
});

afterAll(async () => {
  await prisma.openingBalance.deleteMany({ where: { organizationId } }).catch(() => {});
  // Can't delete POSTED journal entries due to trigger, so delete lines first then entries
  await prisma.journalLine.deleteMany({ where: { entry: { organizationId, status: { not: 'POSTED' } } } }).catch(() => {});
  await prisma.journalEntry.deleteMany({ where: { organizationId, status: { not: 'POSTED' } } }).catch(() => {});
  await prisma.transaction.deleteMany({ where: { organizationId } }).catch(() => {});
  await prisma.userRole.deleteMany({ where: { userId: { in: [ceoId, viewerId, accountantId] } } }).catch(() => {});
  await prisma.organizationMembership.deleteMany({ where: { userId: { in: [ceoId, viewerId, accountantId] } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: [ceoId, viewerId, accountantId] } } }).catch(() => {});
});

describe('M14 Reports & Exports', () => {
  it('computeReport returns a ReportResult for trial-balance with checks array', async () => {
    const ctx = context(ceoId, ['CEO']);
    const result = await computeReport(ctx, 'trial-balance', {});
    expect(result).toBeDefined();
    expect(result.reportKey).toBe('trial-balance');
    expect(result.title).toBe('Trial balance');
    expect(result.category).toBe('FINANCIAL');
    expect(Array.isArray(result.sections)).toBe(true);
    expect(Array.isArray(result.checks)).toBe(true);
    expect(result.checks.length).toBeGreaterThan(0);
    expect(result.checks[0]?.key).toBe('debits-equal-credits');
    expect(typeof result.hasUnverified).toBe('boolean');
    expect(typeof result.currency).toBe('string');
    expect(result.generatedAt).toBeDefined();
    expect(result.filters).toEqual({});
  });

  it('computeReport asset-register returns empty sections[] AND a non-empty unavailableReason (no fake rows)', async () => {
    const ctx = context(ceoId, ['CEO']);
    const result = await computeReport(ctx, 'asset-register', {});
    const def = reportDefinition('asset-register');
    expect(result.reportKey).toBe('asset-register');
    expect(def?.availability).toBe('UNAVAILABLE');
    expect(Array.isArray(result.sections)).toBe(true);
    expect(result.sections.length).toBe(0);
    expect(result.unavailableReason).toBeDefined();
    expect(result.unavailableReason!.length).toBeGreaterThan(0);
    // Verify it mentions the Assets module is a later milestone
    expect(result.unavailableReason).toMatch(/Assets module/i);
  });

  it('computeReport income-statement on a fresh org returns a ReportResult with sections[]', async () => {
    const ctx = context(ceoId, ['CEO']);
    const result = await computeReport(ctx, 'income-statement', {});
    expect(result.reportKey).toBe('income-statement');
    expect(result.title).toBe('Income statement (P&L)');
    expect(result.category).toBe('FINANCIAL');
    expect(Array.isArray(result.sections)).toBe(true);
    // On a fresh org with no transactions, sections may be empty but the structure exists
    expect(result.sections.every((s) => Array.isArray(s.rows))).toBe(true);
    expect(result.checks).toBeDefined();
    expect(result.hasUnverified).toBe(false);
  });

  it('computeReport budget-vs-actual returns sections whose subtotals reflect the availability formula', async () => {
    const ctx = context(ceoId, ['CEO']);
    const result = await computeReport(ctx, 'budget-vs-actual', {});
    expect(result.reportKey).toBe('budget-vs-actual');
    expect(result.title).toBe('Budget vs Actual');
    expect(result.category).toBe('MANAGEMENT');
    expect(Array.isArray(result.sections)).toBe(true);
    // The report should have sections with the availability engine columns (approved, committed, actual, available)
    for (const section of result.sections) {
      if (section.subtotal) {
        // Subtotals should have amount fields that are MarkedAmount objects
        for (const [, value] of Object.entries(section.subtotal)) {
          expect(value).toHaveProperty('amount');
          expect(value).toHaveProperty('currency');
          expect(value).toHaveProperty('unverified');
          expect(Array.isArray(value.unverified)).toBe(true);
        }
      }
    }
  });

  it('Unverified marker test: create an OpeningBalance with isUnverified=true, then computeReport balance-sheet; assert report.hasUnverified is true AND at least one section subtotal has unverified.length > 0', async () => {
    const ctx = context(ceoId, ['CEO']);
    // Find an asset account with a subCategory in ASSET_CATEGORIES
    const assetAccount = await prisma.account.findFirst({
      where: { organizationId, type: 'ASSET', isPostable: true, subCategory: { in: ['CASH', 'BANK', 'MOBILE_MONEY', 'RECEIVABLE', 'OTHER_ASSET'] } },
      select: { id: true, subCategory: true },
    });
    expect(assetAccount).not.toBeNull();
    expect(['CASH', 'BANK', 'MOBILE_MONEY', 'RECEIVABLE', 'OTHER_ASSET']).toContain(assetAccount!.subCategory);
    // Find an open period
    const period = await prisma.financialPeriod.findFirst({
      where: { organizationId, status: 'OPEN' },
      select: { id: true },
    });
    expect(period).not.toBeNull();
    // Clean up any existing opening balance for this account/period
    await prisma.openingBalance.deleteMany({
      where: { accountId: assetAccount!.id, periodId: period!.id },
    });
    // Create an unverified opening balance
    await prisma.openingBalance.create({
      data: {
        organizationId,
        accountId: assetAccount!.id,
        periodId: period!.id,
        amount: 5000000,
        currencyCode: 'TZS',
        source: 'Historical migration balance',
        // Defaults: isUnverified=true, verificationStatus='UNVERIFIED'
      },
    });
    // Also create a journal entry with a line for this account so it appears in the balance sheet
    const periodRecord = await prisma.financialPeriod.findUniqueOrThrow({
      where: { id: period!.id },
      select: { startDate: true, endDate: true },
    });
    const entry = await prisma.journalEntry.create({
      data: {
        organizationId,
        periodId: period!.id,
        type: 'STANDARD',
        status: 'POSTED',
        source: 'MANUAL',
        postedAt: periodRecord.startDate, // Use period start date to ensure it's within the period
      },
    });
    // Need a balanced entry - insert both lines in a single multi-row INSERT so the trigger sees balanced entry
    const liabilityAccount = await prisma.account.findFirst({
      where: { organizationId, type: 'LIABILITY', isPostable: true },
      select: { id: true },
    });
    await prisma.$executeRawUnsafe(
      `INSERT INTO journal_lines (id, organization_id, entry_id, account_id, line_number, debit, credit, currency_code, base_amount, created_at)
       VALUES
         (gen_random_uuid(), $1, $2, $3, 1, 1000, 0, 'TZS', 1000, now()),
         (gen_random_uuid(), $1, $2, $4, 2, 0, 1000, 'TZS', 1000, now())`,
      organizationId,
      entry.id,
      assetAccount!.id,
      liabilityAccount!.id,
    );
    // Compute balance sheet with asAtDate covering the period (use period end date)
    const asAtDate = periodRecord.endDate.toISOString().split('T')[0];
    const result = await computeReport(ctx, 'balance-sheet', { asAtDate });
    expect(result.hasUnverified).toBe(true);
    // At least one section subtotal should have unverified.length > 0
    let foundUnverifiedSubtotal = false;
    for (const section of result.sections) {
      if (section.subtotal) {
        for (const [, value] of Object.entries(section.subtotal)) {
          if (value.unverified.length > 0) {
            foundUnverifiedSubtotal = true;
            // Verify the unverified reason code
            expect(value.unverified[0]?.code).toMatch(/OPENING_BALANCE_(UNVERIFIED|PENDING|DISPUTED)/);
            break;
          }
        }
      }
    }
    expect(foundUnverifiedSubtotal).toBe(true);
  });

  it('Export permission test A: call the export route GET handler with a context lacking EXPORT permission; assert response status is 403 AND an ACCESS_DENIED audit entry was written', async () => {
    // Reset mock to viewer (no CEO role, no EXPORT permission)
    mockRequireContext.mockResolvedValue(context(viewerId));
    const request = new NextRequest('http://test/api/v1/reports/trial-balance/export?format=json');
    const params = Promise.resolve({ reportKey: 'trial-balance' });
    const response = await exportGet(request, { params });
    expect(response.status).toBe(403);
    // Check audit log for ACCESS_DENIED (entityType will be SYSTEM since authorize doesn't pass entity)
    const audit = await prisma.auditLog.findFirst({
      where: {
        entityType: 'SYSTEM',
        action: 'ACCESS_DENIED',
        result: 'DENIED',
      },
      orderBy: { sequence: 'desc' },
    });
    expect(audit).not.toBeNull();
    expect(audit?.result).toBe('DENIED');
  });

  it('Export permission test B: call the export route GET handler as CEO with EXPORT permission; assert response status is 200 AND a REPORT_GENERATED audit entry exists with entityType EXPORT and the correct reportKey in entityId', async () => {
    // Reset mock to CEO (has EXPORT permission via CEO role)
    mockRequireContext.mockResolvedValue(context(ceoId, ['CEO']));
    const request = new NextRequest('http://test/api/v1/reports/trial-balance/export?format=json');
    const params = Promise.resolve({ reportKey: 'trial-balance' });
    const response = await exportGet(request, { params });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toBeDefined();
    expect(body.data.reportKey).toBe('trial-balance');
    // Check audit log for REPORT_GENERATED with entityType EXPORT
    const audit = await prisma.auditLog.findFirst({
      where: {
        entityType: 'EXPORT',
        entityId: 'trial-balance',
        action: 'REPORT_GENERATED',
        result: 'SUCCESS',
      },
      orderBy: { sequence: 'desc' },
    });
    expect(audit).not.toBeNull();
    expect(audit?.entityType).toBe('EXPORT');
    expect(audit?.entityId).toBe('trial-balance');
    expect(audit?.action).toBe('REPORT_GENERATED');
    expect(audit?.result).toBe('SUCCESS');
  });

  it('Export rejects unsupported format: call export with ?format=pdf; assert it returns an error (not a fake file)', async () => {
    mockRequireContext.mockResolvedValue(context(ceoId, ['CEO']));
    const request = new NextRequest('http://test/api/v1/reports/trial-balance/export?format=pdf');
    const params = Promise.resolve({ reportKey: 'trial-balance' });
    const response = await exportGet(request, { params });
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error).toBeDefined();
    expect(body.error.message).toMatch(/PDF export is declared but not yet implemented/i);
  });

  it('Multi-currency: computeReport income-statement with { currency: USD } returns a ReportResult whose currency field is USD (if the org supports it; if not, at minimum the filter is honored and reflected in report.filters.currency)', async () => {
    const ctx = context(ceoId, ['CEO']);
    const result = await computeReport(ctx, 'income-statement', { currency: 'USD' });
    expect(result.filters.currency).toBe('USD');
    // The report currency should reflect the filter (org may not support USD, but filter is honored)
    // At minimum, the filter is reflected in report.filters.currency
    expect(result.filters).toHaveProperty('currency', 'USD');
  });
});