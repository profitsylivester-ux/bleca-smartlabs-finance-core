import { NextResponse } from 'next/server';
import { requireContext } from '@/lib/auth/guard';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { runIdempotent } from '@/lib/api/idempotency';
import { ValidationError } from '@/lib/kernel/errors';
import { createTaxRule, listTaxRules } from '@/lib/tax-compliance/service';
import { taxRuleCreateSchema } from '@/lib/tax-compliance/schemas';

export async function GET() {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const data = await listTaxRules(ctx);
    return ok({ data, count: data.length }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function POST(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const parsed = taxRuleCreateSchema.safeParse(await request.json());
    if (!parsed.success) {
      throw new ValidationError('The request body is invalid.', { issues: parsed.error.issues });
    }
    const key = request.headers.get('idempotency-key');
    if (!key) throw new ValidationError('An Idempotency-Key header is required on this endpoint.');
    const outcome = await runIdempotent({
      key,
      scope: 'POST /api/v1/tax-rules',
      actorId: ctx.actor.userId,
      body: parsed.data,
      handler: async () => ({ status: 201, body: { data: await createTaxRule(ctx, parsed.data) } }),
    });
    if (outcome.kind === 'REPLAYED') {
      return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    }
    return ok(outcome.result, 201, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

