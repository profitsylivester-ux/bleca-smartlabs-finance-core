import 'dotenv/config';
import { prisma } from '@/lib/db/prisma';
import { recordAuditEvent } from '@/lib/db/with-audit';
import { SYSTEM_ACTOR } from '@/lib/audit/writer';
import { verifyChain } from '@/lib/audit/verifier';

/**
 * Writes one audit entry and verifies the chain.
 *
 * Useful as a manual check: it exercises the same writer the application uses,
 * then re-derives every hash and signature from scratch.
 *
 * Usage: npx tsx scripts/audit-smoke.ts "a description"
 */

async function main(): Promise<void> {
  const label = process.argv[2] ?? 'audit smoke test entry';

  await recordAuditEvent(
    { actor: SYSTEM_ACTOR, requestId: `audit-smoke-${Date.now()}` },
    { action: 'SYSTEM', entityType: 'SYSTEM', description: label },
  );

  const chain = await verifyChain({});
  const head = await prisma.auditChainHead.findUnique({ where: { id: 1 } });

  console.log(`head sequence : ${head?.sequence.toString()}`);
  console.log(`head hash     : ${head?.entryHash}`);
  console.log(`chain status  : ${chain.status} across ${chain.entriesChecked} entries`);
  if (chain.status !== 'VERIFIED') {
    console.log(`detail        : ${chain.detail}`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
