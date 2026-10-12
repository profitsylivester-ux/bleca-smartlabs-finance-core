import { NextResponse } from 'next/server';
import { runIdempotent, type IdempotencyOutcome } from '@/lib/api/idempotency';
import { ok } from '@/lib/api/responses';
import { ValidationError } from '@/lib/kernel/errors';
import { withAudit } from '@/lib/db/with-audit';
import type { RequestContext } from '@/lib/kernel/context';
import type { Tx } from '@/lib/db/prisma';
import type { ZodType } from 'zod';

export function requireOrganizationId(ctx: RequestContext): string {
  if (!ctx.actor.organizationId) {
    throw new ValidationError('No organization context.');
  }
  return ctx.actor.organizationId;
}

export function parseBudgetBody<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError('The request body or filters are invalid.', {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

export async function runBudgetMutation<T>(input: {
  request: Request;
  context: RequestContext;
  requestId: string;
  scope: string;
  body: unknown;
  status?: number;
  handler: (tx: Tx) => Promise<T>;
}): Promise<IdempotencyOutcome<T>> {
  const key = input.request.headers.get('idempotency-key');
  if (!key) {
    throw new ValidationError('An Idempotency-Key header is required on this endpoint.');
  }

  const { context, requestId } = input;
  return runIdempotent<T>({
    key,
    scope: input.scope,
    actorId: context.actor.userId,
    body: input.body,
    handler: async () => {
      const result = await withAudit(
        {
          organizationId: context.actor.organizationId,
          actor: {
            id: context.actor.userId,
            name: context.actor.fullName,
            roleCodes: context.actor.roleCodes,
          },
          ipAddress: input.request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
            ?? input.request.headers.get('x-real-ip'),
          userAgent: input.request.headers.get('user-agent'),
          requestId,
          sessionId: context.actor.sessionId,
        },
        input.handler,
      );
      return { status: input.status ?? 200, body: result };
    },
  });
}

export function budgetMutationResponse<T>(
  outcome: IdempotencyOutcome<T>,
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
