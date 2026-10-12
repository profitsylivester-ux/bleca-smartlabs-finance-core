import { NextResponse } from 'next/server';
import { z } from 'zod';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { runIdempotent } from '@/lib/api/idempotency';
import { withAudit } from '@/lib/db/with-audit';
import { writeAuditEntry } from '@/lib/audit/writer';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/kernel/errors';

const releaseSchema = z.object({ reason: z.string().min(10).max(500) });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    // Release is an approval action; the reason is required and preserved on the hold record.
    await authorize(ctx, { module: 'CUSTOMERS', action: 'APPROVE' });
    if (!ctx.actor.organizationId) return apiError(new ValidationError('No organization context'), reqId);
    const key = request.headers.get('idempotency-key');
    if (!key) return apiError(new ValidationError('An Idempotency-Key header is required.'), reqId);
    const { id } = await params;
    const body = releaseSchema.parse(await request.json());
    const customer = await prisma.customer.findFirst({ where: { id, organizationId: ctx.actor.organizationId, deletedAt: null }, select: { id: true, status: true } });
    if (!customer) return apiError(new NotFoundError('Customer', id), reqId);
    if (customer.status !== 'CREDIT_HOLD') return apiError(new ConflictError('Customer does not have an active credit hold.'), reqId);
    const hold = await prisma.customerCreditHold.findFirst({ where: { customerId: id, status: 'ACTIVE' }, orderBy: { heldAt: 'desc' }, select: { id: true, requestedById: true, reason: true, previousCustomerStatus: true } });
    if (!hold) return apiError(new ConflictError('Customer status is on hold but the hold record is missing.'), reqId);
    const h = await headers();
    const ipAddress = h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null;
    const userAgent = h.get('user-agent');
    const outcome = await runIdempotent({
      key, scope: `POST /api/v1/customers/${id}/release`, actorId: ctx.actor.userId, body,
      handler: async () => withAudit({ organizationId: ctx.actor.organizationId!, actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, ipAddress, userAgent, requestId: reqId, sessionId: ctx.actor.sessionId }, async (tx) => {
        if (ctx.actor.userId === hold.requestedById) {
          throw new ConflictError('A credit hold requester cannot approve its release.');
        }
        const releasedAt = new Date();
        await tx.customerCreditHold.update({ where: { id: hold.id }, data: { status: 'RELEASED', releasedById: ctx.actor.userId, releasedAt, releaseReason: body.reason } });
        await tx.customer.update({ where: { id }, data: { status: hold.previousCustomerStatus, creditHoldReason: null, creditHeldAt: null } });
        await writeAuditEntry(tx, { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, {
          action: 'CUSTOMER_CREDIT_HOLD_RELEASED', entityType: 'CUSTOMER_CREDIT_HOLD', entityId: hold.id, entityLabel: id,
          description: `Released customer ${id} from credit hold`,
          changes: { customerStatus: { from: 'CREDIT_HOLD', to: hold.previousCustomerStatus }, releaseReason: { from: null, to: body.reason } },
          metadata: { requestedById: hold.requestedById, releasedById: ctx.actor.userId, originalReason: hold.reason },
        }, { organizationId: ctx.actor.organizationId!, ipAddress, userAgent, requestId: reqId, sessionId: ctx.actor.sessionId });
        return { status: 200, body: { data: { customerId: id, status: hold.previousCustomerStatus, holdId: hold.id, releasedAt, releaseReason: body.reason } } };
      }),
    });
    if (outcome.kind === 'REPLAYED') return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    return ok(outcome.result, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}
