import { NextResponse } from 'next/server';
import { requireContext } from '@/lib/auth/guard';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { runIdempotent } from '@/lib/api/idempotency';
import { ValidationError } from '@/lib/kernel/errors';
import { deleteTaxPayment, getTaxPayment, updateTaxPayment } from '@/lib/tax-compliance/service';
import { taxPaymentUpdateSchema } from '@/lib/tax-compliance/schemas';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const { id } = await params;
    return ok({ data: await getTaxPayment(ctx, id) }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function PATCH(request: Request, { params }: Params) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const parsed = taxPaymentUpdateSchema.safeParse(await request.json());
    if (!parsed.success) {
      throw new ValidationError('The request body is invalid.', { issues: parsed.error.issues });
    }
    const key = request.headers.get('idempotency-key');
    if (!key) throw new ValidationError('An Idempotency-Key header is required on this endpoint.');
    const { id } = await params;
    const outcome = await runIdempotent({
      key,
      scope: `PATCH /api/v1/tax-payments/${id}`,
      actorId: ctx.actor.userId,
      body: parsed.data,
      handler: async () => ({ status: 200, body: { data: await updateTaxPayment(ctx, id, parsed.data) } }),
    });
    if (outcome.kind === 'REPLAYED') {
      return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    }
    return ok(outcome.result, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function DELETE(request: Request, { params }: Params) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const key = request.headers.get('idempotency-key');
    if (!key) throw new ValidationError('An Idempotency-Key header is required on this endpoint.');
    const { id } = await params;
    const outcome = await runIdempotent({
      key,
      scope: `DELETE /api/v1/tax-payments/${id}`,
      actorId: ctx.actor.userId,
      body: { id },
      handler: async () => ({ status: 200, body: { data: await deleteTaxPayment(ctx, id) } }),
    });
    if (outcome.kind === 'REPLAYED') {
      return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    }
    return ok(outcome.result, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}
