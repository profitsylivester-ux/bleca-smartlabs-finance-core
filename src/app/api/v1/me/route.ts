import { NextResponse } from 'next/server';
import { requireContext } from '@/lib/auth/guard';
import { prisma } from '@/lib/db/prisma';

export async function GET() {
  const ctx = await requireContext();
  const userRole = await prisma.userRole.findFirst({
    where: { userId: ctx.actor.userId, revokedAt: null, role: { code: 'CEO' } },
    select: { id: true },
  });
  return NextResponse.json({ isCeo: Boolean(userRole) });
}
