const { PrismaClient } = require('./src/generated/prisma/client');
const { hashPassword } = require('./src/lib/auth/password');
(async () => {
  const p = new PrismaClient();
  const pw = await hashPassword('ChangeMe!Bleca2026#Prod');
  await p.user.update({
    where: { emailNormalized: 'ceo@blecasmartlabs.co.tz' },
    data: {
      passwordHash: pw,
      passwordAlgorithm: 'ARGON2ID',
      passwordChangedAt: new Date(),
      mustChangePassword: false,
      failedLoginCount: 0,
      lockedUntil: null,
    },
  });
  console.log('CEO password reset. mustChangePassword = false');
  await p.$disconnect();
})();
