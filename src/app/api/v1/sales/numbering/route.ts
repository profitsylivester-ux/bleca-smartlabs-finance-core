import { requireContext } from '@/lib/auth/guard';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { getNumberingGaps } from '@/lib/sales/reports';

export async function GET() {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    return ok({ data: await getNumberingGaps(ctx) }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}
