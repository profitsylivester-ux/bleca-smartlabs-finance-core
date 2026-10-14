const { PrismaClient } = require('./src/generated/prisma/client');
const { hashPassword } = require('./src/lib/auth/password');
(async () => {
  const p = new PrismaClient();
  const pw = await hashPassword('testpass1234');
  await p.user.update({
    where: { emailNormalized: 'ceo@blecasmartlabs.co.tz' },
    data: { passwordHash: pw, mustChangePassword: false, failedLoginCount: 0, lockedUntil: null }
  });
  console.log('Reset to: testpass1234');
  await p.$disconnect();
})();
