import type { PrismaClient } from '@/generated/prisma/client';
import { PERMISSIONS, ROLES, ORG, AUTH_POLICY, PROJECTS, FUNDING_SOURCES, CURRENCIES, REASON_CODES, PRODUCTS_SERVICES, CHART_OF_ACCOUNTS_PDF7, type AccountSeed } from '../../../prisma/seed-data';

/**
 * Reference data for the integration suite.
 *
 * Deliberately reuses the production seed catalogue rather than defining a
 * parallel one: a test that seeds different permissions than production would
 * pass while the real configuration was broken.
 */

export async function seedTestFixtures(prisma: PrismaClient): Promise<void> {
  await prisma.authPolicy.upsert({
    where: { name: AUTH_POLICY.name },
    create: AUTH_POLICY,
    update: {},
  });

  for (const p of PERMISSIONS) {
    const resource = p.resource ?? null;
    const existing = await prisma.permission.findFirst({
      where: { module: p.module, action: p.action, resource },
      select: { id: true },
    });
    if (existing) continue;
    await prisma.permission.create({
      data: {
        module: p.module,
        action: p.action,
        resource,
        description: p.description,
        requiresStepUpAuth: p.requiresStepUpAuth ?? false,
      },
    });
  }

  for (const role of ROLES) {
    const record = await prisma.role.upsert({
      where: { code: role.code },
      create: {
        code: role.code,
        name: role.name,
        description: role.description,
        type: 'SYSTEM',
        isSystem: true,
        isFinalApprover: role.isFinalApprover,
        canBypassApproval: false,
      },
      update: {},
      select: { id: true },
    });

    const already = await prisma.rolePermission.count({ where: { roleId: record.id } });
    if (already > 0) continue;

    for (const grant of role.permissions) {
      const permission = await prisma.permission.findFirst({
        where: { module: grant.module, action: grant.action, resource: grant.resource ?? null },
        select: { id: true },
      });
      if (!permission) continue;
      await prisma.rolePermission.create({
        data: { roleId: record.id, permissionId: permission.id },
      });
    }
  }

  await prisma.organization.upsert({
    where: { code: ORG.code },
    create: {
      code: ORG.code,
      name: ORG.name,
      registrationStatus: ORG.registrationStatus,
      baseCurrency: ORG.baseCurrency,
      fiscalYearStartMonth: ORG.fiscalYearStartMonth,
      fiscalYearEndDay: ORG.fiscalYearEndDay,
    },
    update: {},
  });

  const org = await prisma.organization.findUniqueOrThrow({ where: { code: ORG.code } });

  for (const proj of PROJECTS) {
    await prisma.project.upsert({
      where: { organizationId_code: { organizationId: org.id, code: proj.code } },
      create: { ...proj, organizationId: org.id },
      update: { ...proj, organizationId: org.id },
    });
  }

  for (const fs of FUNDING_SOURCES) {
    await prisma.fundingSource.upsert({
      where: { organizationId_code: { organizationId: org.id, code: fs.code } },
      create: { ...fs, organizationId: org.id },
      update: { ...fs, organizationId: org.id },
    });
  }

  for (const cur of CURRENCIES) {
    await prisma.currency.upsert({
      where: { code: cur.code },
      create: cur,
      update: cur,
    });
  }

  for (const rc of REASON_CODES) {
    await prisma.reasonCode.upsert({
      where: { organizationId_code: { organizationId: org.id, code: rc.code } },
      create: { ...rc, organizationId: org.id },
      update: { ...rc, organizationId: org.id },
    });
  }

  for (const ps of PRODUCTS_SERVICES) {
    const currency = await prisma.currency.findUnique({ where: { code: ps.currencyCode } });
    if (!currency) continue;
    await prisma.productService.upsert({
      where: { organizationId_code: { organizationId: org.id, code: ps.code } },
      create: {
        organizationId: org.id,
        code: ps.code,
        name: ps.name,
        description: ps.description,
        type: ps.type,
        unit: ps.unit,
        unitPrice: ps.unitPrice ? Number(ps.unitPrice) : null,
        currencyCode: currency.code,
      },
      update: {
        name: ps.name,
        description: ps.description,
        type: ps.type,
        unit: ps.unit,
        unitPrice: ps.unitPrice ? Number(ps.unitPrice) : null,
        currencyCode: currency.code,
      },
    });
  }

  // Seed Chart of Accounts (PDF §7)
  const accountsByCode = new Map<string, { id: string; code: string }>();
  for (const acc of CHART_OF_ACCOUNTS_PDF7) {
    const parentId = acc.parentCode ? accountsByCode.get(acc.parentCode)?.id : null;
    const existing = await prisma.account.findUnique({
      where: { organizationId_code: { organizationId: org.id, code: acc.code } },
      select: { id: true, code: true },
    });

    if (existing) {
      const updated = await prisma.account.update({
        where: { id: existing.id },
        data: {
          name: acc.name,
          description: acc.description,
          type: acc.type,
          subCategory: acc.subCategory as import('@/generated/prisma/client').AccountSubCategory | null,
          normalBalance: acc.normalBalance,
          parentId,
          isPostable: acc.isPostable ?? true,
          isReconcilable: acc.isReconcilable ?? false,
          requiresDocument: acc.requiresDocument ?? false,
          status: (acc as AccountSeed & { status?: string }).status ?? 'ACTIVE',
        },
        select: { id: true, code: true },
      });
      accountsByCode.set(acc.code, updated);
      continue;
    }

    const created = await prisma.account.create({
      data: {
        organizationId: org.id,
        code: acc.code,
        name: acc.name,
        description: acc.description,
        type: acc.type,
        subCategory: acc.subCategory as import('@/generated/prisma/client').AccountSubCategory | null,
        normalBalance: acc.normalBalance,
        parentId,
        isPostable: acc.isPostable ?? true,
        isReconcilable: acc.isReconcilable ?? false,
        requiresDocument: acc.requiresDocument ?? false,
        status: (acc as AccountSeed & { status?: string }).status ?? 'ACTIVE',
      },
      select: { id: true, code: true },
    });

    accountsByCode.set(acc.code, created);
  }

  // Create financial periods for 2025 fiscal year
  await createFiscalYearPeriods(prisma, org.id, 2025);
}

async function createFiscalYearPeriods(prisma: PrismaClient, orgId: string, year: number): Promise<void> {
  const startOfYear = new Date(Date.UTC(year, 0, 1));
  const endOfYear = new Date(Date.UTC(year, 11, 31, 23, 59, 59));

  // Check if periods already exist
  const existingCount = await prisma.financialPeriod.count({
    where: { organizationId: orgId },
  });
  if (existingCount > 0) return;

  // Monthly periods
  for (let month = 0; month < 12; month++) {
    const startDate = new Date(Date.UTC(year, month, 1));
    const endDate = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59));
    const code = `${year}-${String(month + 1).padStart(2, '0')}`;
    const name = `${year}-${String(month + 1).padStart(2, '0')}`;

    await prisma.financialPeriod.create({
      data: {
        organizationId: orgId,
        type: 'MONTHLY',
        status: month === 0 ? 'OPEN' : 'OPEN',
        code,
        name,
        startDate,
        endDate,
      },
    });
  }

  // Quarterly periods
  const quarters = [
    { q: 1, start: 0, end: 2 },
    { q: 2, start: 3, end: 5 },
    { q: 3, start: 6, end: 8 },
    { q: 4, start: 9, end: 11 },
  ];

  for (const q of quarters) {
    const startDate = new Date(Date.UTC(year, q.start, 1));
    const endDate = new Date(Date.UTC(year, q.end + 1, 0, 23, 59, 59));
    const code = `${year}-Q${q.q}`;
    const name = `Q${q.q} ${year}`;

    await prisma.financialPeriod.create({
      data: {
        organizationId: orgId,
        type: 'QUARTERLY',
        status: 'OPEN',
        code,
        name,
        startDate,
        endDate,
      },
    });
  }

  // Annual period
  await prisma.financialPeriod.create({
    data: {
      organizationId: orgId,
      type: 'ANNUAL',
      status: 'OPEN',
      code: `${year}`,
      name: `FY ${year}`,
      startDate: startOfYear,
      endDate: endOfYear,
    },
  });

  // Lock the first monthly period for testing
  const firstPeriod = await prisma.financialPeriod.findFirst({
    where: { organizationId: orgId, type: 'MONTHLY' },
    orderBy: { startDate: 'asc' },
    select: { id: true },
  });

  if (firstPeriod) {
    await prisma.financialPeriod.update({
      where: { id: firstPeriod.id },
      data: { status: 'LOCKED', lockedAt: new Date() },
    });
  }
}

/**
 * Empties the tables an integration test writes to.
 *
 * TRUNCATE, not DELETE: it does not fire row triggers, which matters because
 * audit_logs has triggers that deliberately forbid DELETE. The test data is
 * recreated by seedTestFixtures immediately afterwards.
 *
 * The audit chain head is NOT reset. Resetting it would make every test
 * independent, but the chain is deliberately global and cumulative: a test that
 * assumed it owned sequence 1 would be testing a fiction.
 */
export async function resetTestData(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      audit_logs,
      security_events,
      audit_chain_checkpoints,
      sessions,
      login_history,
      mfa_devices,
      idempotency_keys,
      notification_preferences,
      notifications,
      access_review_items,
      access_reviews,
      delegations,
      user_roles,
      organization_memberships,
      users,
      exchange_rates,
      currencies,
      products_services,
      reason_codes
    RESTART IDENTITY CASCADE
  `);
}

/**
 * Removes a test user and everything that cascades from them.
 *
 * The sessions trigger (prisma/migrations/*_audit_guards) refuses to delete a
 * session that is still live, and deleting the user cascades into sessions. So
 * the sessions are revoked and back-dated first - which is exactly the order the
 * runbook tells an operator to use, so the fixture exercises the real procedure
 * rather than working around the guard.
 */
export async function destroyUser(prisma: PrismaClient, userId: string): Promise<void> {
  await prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: 'ADMIN_REVOKED', absoluteExpiresAt: new Date(0) },
  });

  await prisma.delegation.deleteMany({
    where: { OR: [{ grantorId: userId }, { granteeId: userId }] },
  });

  await prisma.user.deleteMany({ where: { id: userId } });
}
