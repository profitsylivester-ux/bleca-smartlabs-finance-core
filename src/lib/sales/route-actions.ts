import { apiError, requestId } from '@/lib/api/responses';
import { requireContext } from '@/lib/auth/guard';
import { parseSalesBody, runSalesMutation, salesMutationResponse } from '@/lib/sales/api';
import type { RequestContext } from '@/lib/kernel/context';
import type { ZodType } from 'zod';

export async function mutateSalesAction<T, B>(input: {
  request: Request;
  scope: string;
  schema: ZodType<B>;
  handler: (ctx: RequestContext, body: B) => Promise<T>;
  status?: number;
}) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const body = parseSalesBody(input.schema, await input.request.json());
    const outcome = await runSalesMutation({
      request: input.request,
      context: ctx,
      scope: input.scope,
      body,
      status: input.status,
      handler: () => input.handler(ctx, body),
    });
    return salesMutationResponse(outcome, reqId, input.status);
  } catch (error) {
    return apiError(error, reqId);
  }
}
