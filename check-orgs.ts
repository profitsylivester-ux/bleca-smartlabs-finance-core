import { PrismaClient } from './src/generated/prisma/client';
const prisma = new PrismaClient();
async function main() {
  const orgs = await prisma.organization.findMany({ where: { code: 'BLECA' } });
  console.log('Organizations with code BLECA:', orgs.length, orgs.map(o => ({ id: o.id, code: o.code })));
  await prisma.$disconnect();
}
main();