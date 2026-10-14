import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireContext } from '@/lib/auth/guard';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { runIdempotent } from '@/lib/api/idempotency';
import { ValidationError } from '@/lib/kernel/errors';
import { createCredential, listCredentials } from '@/lib/tax-compliance/service';
import { credentialCreateSchema } from '@/lib/tax-compliance/schemas';

const querySchema = z.object({
  status: z.enum(['PENDING', 'ACTIVE', 'EXPIRING_SOON', 'EXPIRED', 'REVOKED', 'NOT_APPLICABLE']).optional(),
  type: z.enum(['REGISTRATION', 'TIN_CERTIFICATE', 'LICENCE', 'PERMIT', 'CERTIFICATION', 'MEMBERSHIP', 'DOMAIN', 'INSURANCE', 'SOFTWARE_SUBSCRIPTION', 'OTHER']).optional(),
});

export async function GET(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const query = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams.entries()));
    const data = await listCredentials(ctx, query);
    return ok({ data, count: data.length }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function POST(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const parsed = credentialCreateSchema.safeParse(await request.json());
    if (!parsed.success) {
      throw new ValidationError('The request body is invalid.', { issues: parsed.error.issues });
    }
    const key = request.headers.get('idempotency-key');
    if (!key) throw new ValidationError('An Idempotency-Key header is required on this endpoint.');
    const outcome = await runIdempotent({
      key,
      scope: 'POST /api/v1/credentials',
      actorId: ctx.actor.userId,
      body: parsed.data,
      handler: async () => ({ status: 201, body: { data: await createCredential(ctx, parsed.data) } }),
    });
    if (outcome.kind === 'REPLAYED') {
      return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    }
    return ok(outcome.result, 201, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

