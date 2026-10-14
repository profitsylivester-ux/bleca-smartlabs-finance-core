const { PrismaClient } = require('./src/generated/prisma/client');
const { hashPassword } = require('./src/lib/auth/password');

(async () => {
  const p = new PrismaClient();
  const pw = await hashPassword('FinOfficer!Bleca2026');
  const org = await p.organization.findFirstOrThrow();
  const role = await p.role.findUniqueOrThrow({ where: { code: 'FINANCE_OFFICER' } });

  const u = await p.user.upsert({
    where: { emailNormalized: 'finance@blecasmartlabs.co.tz' },
    update: { mfaEnforced: false, isActive: true, status: 'ACTIVE', passwordHash: pw, passwordAlgorithm: 'ARGON2ID' },
    create: {
      email: 'finance@blecasmartlabs.co.tz',
      emailNormalized: 'finance@blecasmartlabs.co.tz',
      fullName: 'BLECA Finance Officer',
      status: 'ACTIVE',
      isActive: true,
      mfaEnforced: false,
      passwordHash: pw,
      passwordAlgorithm: 'ARGON2ID',
      passwordChangedAt: new Date(),
      emailVerifiedAt: new Date(),
    },
  });

  await p.organizationMembership.upsert({
    where: { organizationId_userId: { organizationId: org.id, userId: u.id } },
    update: {},
    create: { organizationId: org.id, userId: u.id, isDefault: true },
  });

  const existingRole = await p.userRole.findFirst({ where: { userId: u.id, roleId: role.id } });
  if (!existingRole) {
    await p.userRole.create({ data: { userId: u.id, roleId: role.id, reason: 'Initial Finance Officer' } });
  }

  console.log('SUCCESS: Finance Officer ready');
  console.log('Email:', u.emailNormalized);
  console.log('Password: FinOfficer!Bleca2026');
  await p.$disconnect();
})();
