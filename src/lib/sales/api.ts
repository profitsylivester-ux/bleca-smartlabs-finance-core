import { NextResponse } from 'next/server';
import { runIdempotent, type IdempotencyOutcome } from '@/lib/api/idempotency';
import { ok } from '@/lib/api/responses';
import { ValidationError } from '@/lib/kernel/errors';
import type { RequestContext } from '@/lib/kernel/context';
import type { ZodType } from 'zod';

export function parseSalesBody<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError('The request body or filters are invalid.', { issues: parsed.error.issues });
  }
  return parsed.data;
}

export async function runSalesMutation<T>(input: {
  request: Request;
  context: RequestContext;
  scope: string;
  body: unknown;
  status?: number;
  handler: () => Promise<T>;
}): Promise<IdempotencyOutcome<{ data: T }>> {
  const key = input.request.headers.get('idempotency-key');
  if (!key) throw new ValidationError('An Idempotency-Key header is required on this endpoint.');
  return runIdempotent({
    key,
    scope: input.scope,
    actorId: input.context.actor.userId,
    body: input.body,
    handler: async () => ({
      status: input.status ?? 200,
      body: { data: await input.handler() },
    }),
  });
}

export function salesMutationResponse<T>(
  outcome: IdempotencyOutcome<{ data: T }>,
  requestId: string,
  status = 200,
): NextResponse {
  if (outcome.kind === 'REPLAYED') {
    return NextResponse.json(outcome.responseBody, {
      status: outcome.responseStatus,
      headers: { 'x-request-id': requestId },
    });
  }
  return ok(outcome.result, status, requestId);
}
