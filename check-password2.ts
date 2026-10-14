const { PrismaClient } = require('./src/generated/prisma/client');
const { verifyPassword } = require('./src/lib/auth/password');
(async () => {
  const p = new PrismaClient();
  const u = await p.user.findUnique({ where: { emailNormalized: 'ceo@blecasmartlabs.co.tz' } });
  const ok = await verifyPassword(u.passwordHash, 'ChangeMe!Bleca2026#Prod');
  console.log('Hash verifies:', ok);
  console.log('mustChangePassword:', u.mustChangePassword);
  console.log('lockedUntil:', u.lockedUntil);
  console.log('failedLoginCount:', u.failedLoginCount);
  await p.$disconnect();
})();
