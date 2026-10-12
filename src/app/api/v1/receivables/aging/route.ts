import { z } from 'zod';
import { requireContext } from '@/lib/auth/guard';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { getAgingReport } from '@/lib/sales/reports';

export async function GET(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const { asOf } = z.object({ asOf: z.string().min(10).optional() }).parse(Object.fromEntries(new URL(request.url).searchParams.entries()));
    const report = await getAgingReport(ctx, 'RECEIVABLE', asOf ? new Date(asOf) : new Date());
    return ok({ data: report }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}
