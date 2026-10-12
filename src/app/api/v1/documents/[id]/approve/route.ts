import { z } from 'zod';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { ValidationError } from '@/lib/kernel/errors';
import { decideDocumentApproval, submitDocumentForApproval } from '@/lib/documents/service';

const schema = z.object({
  action: z.enum(['SUBMIT', 'APPROVE', 'REJECT']),
  requestId: z.string().optional(),
  reason: z.string().trim().max(1000).optional(),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const { id } = await params;
    const input = schema.parse(await request.json());
    if (input.action === 'SUBMIT') {
      await authorize(ctx, { module: 'DOCUMENTS', action: 'SUBMIT', entity: { type: 'DOCUMENT', id } });
      return ok({ data: await submitDocumentForApproval(ctx, id) }, 201, reqId);
    }
    if (!input.requestId || !input.reason?.trim()) {
      throw new ValidationError('Approval decisions require a requestId and reason.');
    }
    await authorize(ctx, {
      module: 'DOCUMENTS', action: input.action === 'APPROVE' ? 'APPROVE' : 'REJECT',
      entity: { type: 'DOCUMENT', id },
    });
    const decision = input.action === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    const result = await decideDocumentApproval(ctx, id, input.requestId, decision, input.reason);
    return ok({ data: result }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}
