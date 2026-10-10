import type { PrismaClient } from '@/generated/prisma/client';
import { PERMISSIONS, ROLES, ORG, AUTH_POLICY, PROJECTS, FUNDING_SOURCES, CURRENCIES, REASON_CODES, PRODUCTS_SERVICES } from '../../../prisma/seed-data';

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
