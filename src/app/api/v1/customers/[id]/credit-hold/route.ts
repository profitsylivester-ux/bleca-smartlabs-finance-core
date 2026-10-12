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

const holdSchema = z.object({ reason: z.string().min(10).max(500) });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'CUSTOMERS', action: 'EDIT' });
    if (!ctx.actor.organizationId) return apiError(new ValidationError('No organization context'), reqId);
    const key = request.headers.get('idempotency-key');
    if (!key) return apiError(new ValidationError('An Idempotency-Key header is required.'), reqId);
    const { id } = await params;
    const body = holdSchema.parse(await request.json());
    const customer = await prisma.customer.findFirst({ where: { id, organizationId: ctx.actor.organizationId, deletedAt: null }, select: { id: true, status: true } });
    if (!customer) return apiError(new NotFoundError('Customer', id), reqId);
    if (customer.status === 'BLOCKED') return apiError(new ConflictError('A blocked customer cannot be placed on a credit hold.'), reqId);
    if (customer.status === 'CREDIT_HOLD') return apiError(new ConflictError('Customer already has an active credit hold.'), reqId);
    const h = await headers();
    const ipAddress = h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null;
    const userAgent = h.get('user-agent');
    const outcome = await runIdempotent({
      key, scope: `POST /api/v1/customers/${id}/credit-hold`, actorId: ctx.actor.userId, body,
      handler: async () => withAudit({ organizationId: ctx.actor.organizationId!, actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, ipAddress, userAgent, requestId: reqId, sessionId: ctx.actor.sessionId }, async (tx) => {
        const heldAt = new Date();
        const hold = await tx.customerCreditHold.create({ data: { customerId: id, previousCustomerStatus: customer.status, reason: body.reason, requestedById: ctx.actor.userId, heldAt }, select: { id: true, status: true, reason: true, heldAt: true } });
        await tx.customer.update({ where: { id }, data: { status: 'CREDIT_HOLD', creditHoldReason: body.reason, creditHeldAt: heldAt } });
        await writeAuditEntry(tx, { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, {
          action: 'CUSTOMER_CREDIT_HOLD', entityType: 'CUSTOMER_CREDIT_HOLD', entityId: hold.id, entityLabel: id,
          description: `Placed customer ${id} on credit hold`,
          changes: { customerStatus: { from: customer.status, to: 'CREDIT_HOLD' }, reason: { from: null, to: body.reason } },
        }, { organizationId: ctx.actor.organizationId!, ipAddress, userAgent, requestId: reqId, sessionId: ctx.actor.sessionId });
        return { status: 201, body: { data: { customerId: id, hold } } };
      }),
    });
    if (outcome.kind === 'REPLAYED') return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    return ok(outcome.result, 201, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}
