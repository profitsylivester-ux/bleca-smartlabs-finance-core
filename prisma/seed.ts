import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/client';
import { hashPassword } from '../src/lib/auth/password';
import { PERMISSIONS, ROLES, ORG, AUTH_POLICY } from './seed-data';

/**
 * Idempotent seed.
 *
 * Running it twice must produce the same database, because it is the documented
 * way to provision a new environment and a seed that only works once turns that
 * into a trap.
 *
 * It refuses to invent a CEO credential. If SEED_CEO_EMAIL / SEED_CEO_PASSWORD
 * are unset it creates the CEO role and the organisation but no user, and says
 * so. A default password baked into a repository is a default password.
 */

const prisma = new PrismaClient();

async function seedAuthPolicy() {
  const existing = await prisma.authPolicy.findUnique({ where: { name: AUTH_POLICY.name } });
  if (existing) {
    const { name, priority, ...rest } = AUTH_POLICY;
    void name;
    void priority;
    return prisma.authPolicy.update({ where: { name: AUTH_POLICY.name }, data: rest });
  }
  return prisma.authPolicy.create({ data: AUTH_POLICY });
}

async function seedPermissions() {
  /**
   * Looked up by findFirst rather than by the compound unique key.
   *
   * `resource` is nullable, and Prisma's generated compound-unique input types a
   * nullable member as a required String, so `resource: null` is rejected at the
   * type level even though the database allows it. findFirst expresses the same
   * lookup without changing the schema to suit the codegen.
   */
  for (const p of PERMISSIONS) {
    const resource = p.resource ?? null;

    const existing = await prisma.permission.findFirst({
      where: { module: p.module, action: p.action, resource },
      select: { id: true },
    });

    if (existing) {
      await prisma.permission.update({
        where: { id: existing.id },
        data: { description: p.description, requiresStepUpAuth: p.requiresStepUpAuth ?? false },
      });
      continue;
    }

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
  return PERMISSIONS.length;
}

async function seedRoles() {
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
      update: {
        name: role.name,
        description: role.description,
        isFinalApprover: role.isFinalApprover,
        // Q3: no role ever carries a standing approval bypass. Enforced here as
        // well as in code so a manual UPDATE cannot introduce one silently.
        canBypassApproval: false,
      },
    });

    await prisma.rolePermission.deleteMany({ where: { roleId: record.id } });

    for (const grant of role.permissions) {
      const permission = await prisma.permission.findFirst({
        where: {
          module: grant.module,
          action: grant.action,
          resource: grant.resource ?? null,
        },
        select: { id: true },
      });

      if (!permission) {
        throw new Error(
          `Seed bug: role ${role.code} references ${grant.module}:${grant.action}:${grant.resource ?? '-'} ` +
            'which is not in the PERMISSIONS catalogue.',
        );
      }

      await prisma.rolePermission.create({
        data: { roleId: record.id, permissionId: permission.id },
      });
    }
  }

  return ROLES.map((r) => `${r.code} (${r.permissions.length} grants)`).join(', ');
}

async function seedOrganization() {
  const org = await prisma.organization.upsert({
    where: { code: ORG.code },
    create: {
      code: ORG.code,
      name: ORG.name,
      legalName: ORG.legalName,
      registrationStatus: ORG.registrationStatus,
      baseCurrency: ORG.baseCurrency,
      fiscalYearStartMonth: ORG.fiscalYearStartMonth,
      fiscalYearEndDay: ORG.fiscalYearEndDay,
      // No TIN is invented. It stays null until BLECA is actually registered.
      tin: null,
    },
    update: { name: ORG.name },
  });

  return org;
}

async function seedCeo(orgId: string) {
  const email = process.env.SEED_CEO_EMAIL?.trim();
  const password = process.env.SEED_CEO_PASSWORD;

  if (!email || !password) {
    return {
      created: false,
      message:
        'No CEO user created. Set SEED_CEO_EMAIL and SEED_CEO_PASSWORD in .env.local and re-run `npm run db:seed`.',
    };
  }

  const emailNormalized = email.toLowerCase();
  const existing = await prisma.user.findUnique({ where: { emailNormalized } });

  if (existing) {
    return {
      created: false,
      message: `CEO account ${emailNormalized} already exists; left unchanged.`,
    };
  }

  const hashed = await hashPassword(password);
  const ceoRole = await prisma.role.findUniqueOrThrow({
    where: { code: 'CEO' },
    select: { id: true },
  });

  const user = await prisma.user.create({
    data: {
      email,
      emailNormalized,
      fullName: 'BLECA SmartLabs CEO',
      jobTitle: 'Chief Executive Officer',
      status: 'ACTIVE',
      isActive: true,
      emailVerifiedAt: new Date(),
      passwordHash: hashed,
      passwordAlgorithm: 'ARGON2ID',
      passwordChangedAt: new Date(),
      // MFA is not merely enabled, it is mandatory: the CEO cannot complete an
      // enrolment from a screen and then simply not use the factor. The next
      // sign-in is held at the challenge until a device is confirmed.
      mfaEnforced: true,
      mustChangePassword: true,
      organizationMemberships: { create: { organizationId: orgId, isDefault: true } },
      userRoles: {
        create: {
          roleId: ceoRole.id,
          grantedAt: new Date(),
          reason: 'Bootstrap: organisation founder',
        },
      },
    },
    select: { id: true, emailNormalized: true },
  });

  return {
    created: true,
    message:
      `CEO account created for ${user.emailNormalized}. ` +
      'MFA enrolment is required at first sign-in, and a password change is required. ' +
      'Set SEED_CEO_PASSWORD to something you have not used elsewhere.',
  };
}

async function main() {
  console.log('Seeding BLECA SmartLabs Finance (Milestone 1 foundation)\n');

  await seedAuthPolicy();
  console.log(
    `  auth policy     ${AUTH_POLICY.name} (MFA required for: ${AUTH_POLICY.mfaRequiredRoleCodes.join(', ')})`,
  );

  const permissionCount = await seedPermissions();
  console.log(`  permissions     ${permissionCount}`);

  const roleSummary = await seedRoles();
  console.log(`  roles           ${roleSummary}`);

  const org = await seedOrganization();
  console.log(
    `  organisation    ${org.name} [${org.code}] status=${org.registrationStatus} ` +
      `base=${org.baseCurrency} tin=${org.tin ?? 'null (not yet registered)'}`,
  );

  const ceo = await seedCeo(org.id);
  console.log(`  CEO account     ${ceo.message}`);

  console.log('\nSeed complete. Next: npm run dev');
}

main()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
