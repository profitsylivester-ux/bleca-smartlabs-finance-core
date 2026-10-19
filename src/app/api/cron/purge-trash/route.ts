import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';

export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

  const oldRequests = await prisma.masterDataChangeRequest.findMany({
    where: { status: 'APPROVED', approvedAt: { lt: ninetyDaysAgo } }
  });

  const purged = [];
  const modelMap: Record<string, { delete: (args: { where: { id: string } }) => Promise<unknown> }> = {
    LOCATION: prisma.location,
    DEPARTMENT: prisma.department,
    COST_CENTRE: prisma.costCentre,
    PROJECT: prisma.project,
    FUNDING_SOURCE: prisma.fundingSource,
    CURRENCY: prisma.currency,
    EXCHANGE_RATE: prisma.exchangeRate,
    REASON_CODE: prisma.reasonCode,
    PRODUCT_SERVICE: prisma.productService,
  };

  for (const req of oldRequests) {
    const pc = req.proposedChanges as Record<string, unknown>;
    if (pc && pc.deletedAt) {
      const model = modelMap[req.entityType];
      if (model && req.entityId) {
        try { await model.delete({ where: { id: req.entityId } }); } catch {}
      }
      await prisma.masterDataChangeRequest.delete({ where: { id: req.id } });
      purged.push(req.id);
    }
  }

  return NextResponse.json({ purged: purged.length });
}
