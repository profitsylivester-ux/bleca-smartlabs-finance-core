import { z } from 'zod';
import { requireContext } from '@/lib/auth/guard';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { getTaxReport } from '@/lib/tax-compliance/service';

const querySchema = z.object({
  period: z.string().trim().min(1).max(40).optional(),
});

export async function GET(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const query = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams.entries()));
    return ok({ data: await getTaxReport(ctx, query) }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

