import { NextResponse } from 'next/server';
import { requireContext } from '@/lib/auth/guard';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { runIdempotent } from '@/lib/api/idempotency';
import { ValidationError } from '@/lib/kernel/errors';
import { deleteComplianceDocument } from '@/lib/tax-compliance/service';

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const { id } = await params;
    const key = request.headers.get('idempotency-key');
    if (!key) throw new ValidationError('An Idempotency-Key header is required on this endpoint.');
    const outcome = await runIdempotent({
      key,
      scope: `DELETE /api/v1/compliance-documents/${id}`,
      actorId: ctx.actor.userId,
      body: { id },
      handler: async () => ({ status: 200, body: { data: await deleteComplianceDocument(ctx, id) } }),
    });
    if (outcome.kind === 'REPLAYED') {
      return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    }
    return ok(outcome.result, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}
