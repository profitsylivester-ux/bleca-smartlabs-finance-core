import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/kernel/errors';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'SUPPLIERS', action: 'VIEW' });
    if (!ctx.actor.organizationId) return apiError(new ValidationError('No organization context'), reqId);
    const { id } = await params;
    const supplier = await prisma.supplier.findFirst({
      where: { id, organizationId: ctx.actor.organizationId, deletedAt: null },
      select: {
        id: true, status: true, masterDataStatus: true, riskLevel: true,
        performanceRating: true, deliveryRating: true, qualityRating: true,
        bankDetailChangeRequests: { where: { status: { in: ['PENDING', 'VERIFICATION_PENDING', 'APPROVAL_PENDING'] } }, select: { id: true, status: true, requestedAt: true } },
        bankDetails: { where: { isActive: true }, select: { id: true, isPrimary: true } },
        taxObligations: { select: { taxObligationId: true } },
      },
    });
    if (!supplier) return apiError(new NotFoundError('Supplier', id), reqId);
    const alerts: string[] = [];
    if (supplier.status !== 'ACTIVE' || supplier.masterDataStatus !== 'ACTIVE') alerts.push('Supplier profile is not active and approved.');
    if (supplier.riskLevel === 'HIGH' || supplier.riskLevel === 'CRITICAL') alerts.push(`Supplier risk level is ${supplier.riskLevel}.`);
    if (supplier.bankDetailChangeRequests.length > 0) alerts.push('Payments are blocked while a bank detail change is pending.');
    if (!supplier.bankDetails.some((detail) => detail.isPrimary)) alerts.push('Supplier has no active primary bank detail.');
    return ok({ data: { ...supplier, riskAlerts: alerts } }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}
