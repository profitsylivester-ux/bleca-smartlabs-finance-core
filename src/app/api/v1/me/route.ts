import { NextResponse } from 'next/server';
import { requireContext } from '@/lib/auth/guard';
import { prisma } from '@/lib/db/prisma';

export async function GET() {
  const ctx = await requireContext();
  const orgId = ctx.actor.organizationId;
  if (!orgId) return NextResponse.json({ isCeo: false });
  const isCeo = Boolean(
    await prisma.userRole.findFirst({
      where: {
        userId: ctx.actor.userId,
        revokedAt: null,
        role: { code: 'CEO', organizationId: orgId },
      },
    }),
  );
  return NextResponse.json({ isCeo });
}
