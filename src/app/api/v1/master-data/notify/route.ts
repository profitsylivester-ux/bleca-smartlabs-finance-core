import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';

export async function POST(req: Request) {
  try {
    const ctx = await requireContext();
    if (!ctx.actor.organizationId) return NextResponse.json({ ok: false });
    const { action, entityType } = await req.json();

    const fos = await prisma.userRole.findMany({
      where: { role: { code: 'FINANCE_OFFICER' }, revokedAt: null },
      select: { userId: true }
    });

    for (const fo of fos) {
      if (fo.userId === ctx.actor.userId) continue;
      await prisma.notification.create({
        data: {
          organizationId: ctx.actor.organizationId,
          userId: fo.userId,
          category: 'SYSTEM',
          severity: 'INFO',
          channel: 'IN_APP',
          status: 'SENT',
          title: entityType + ' ' + (action === 'EDIT' ? 'edited' : 'updated'),
          body: 'A ' + entityType.toLowerCase() + ' record was updated by ' + ctx.actor.fullName + '.',
          actionUrl: '/master-data'
        }
      });
    }
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false });
  }
}
