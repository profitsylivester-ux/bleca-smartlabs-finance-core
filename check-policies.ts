import { PrismaClient } from './src/generated/prisma/client';
const prisma = new PrismaClient();
async function main() {
  const policies = await prisma.approvalPolicy.findMany({ where: { entityType: 'TRANSACTION' }, include: { steps: true } });
  console.log('Policies:', JSON.stringify(policies, null, 2));
  await prisma.$disconnect();
}
main();