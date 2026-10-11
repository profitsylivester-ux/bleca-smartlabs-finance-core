import { PrismaClient } from './src/generated/prisma/client';
const prisma = new PrismaClient();
async function main() {
  const role = await prisma.role.findUnique({ where: { code: 'CEO' }, select: { id: true, code: true } });
  console.log('CEO Role:', role);
  await prisma.$disconnect();
}
main();