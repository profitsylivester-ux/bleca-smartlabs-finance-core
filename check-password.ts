const { PrismaClient } = require('./src/generated/prisma/client');
const { verifyPassword } = require('./src/lib/auth/password');
(async () => {
  const p = new PrismaClient();
  const u = await p.user.findUnique({ where: { emailNormalized: 'ceo@blecasmartlabs.co.tz' } });
  if (!u) { console.log('NO USER'); process.exit(0); }
  const ok = await verifyPassword('ChangeMe!Bleca2026#Prod', u.passwordHash);
  console.log('Hash verifies:', ok);
  await p.$disconnect();
})();
