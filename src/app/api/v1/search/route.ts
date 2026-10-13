import { NextRequest } from 'next/server';
import { z } from 'zod';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { withAudit } from '@/lib/db/with-audit';
import { writeAuditEntry } from '@/lib/audit/writer';
import { globalSearch } from '@/lib/search/service';

const searchSchema = z.object({
  q: z.string().min(2).max(200),
});

export async function GET(request: NextRequest) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'SEARCH', action: 'VIEW' });

    const { searchParams } = new URL(request.url);
    const params = searchSchema.parse({ q: searchParams.get('q') ?? '' });

    const hits = await globalSearch(ctx, params.q);

    await withAudit(
      {
        organizationId: ctx.actor.organizationId!,
        actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
        requestId: reqId,
      },
      async (tx) => {
        await writeAuditEntry(
          tx,
          { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
          {
            action: 'REPORT_GENERATED',
            entityType: 'REPORT',
            entityId: reqId,
            entityLabel: `Search: ${params.q}`,
            description: `Global search for "${params.q}" returned ${hits.length} results`,
            metadata: { query: params.q, resultCount: hits.length },
          },
          { organizationId: ctx.actor.organizationId!, requestId: reqId },
        );
      },
    );

    return ok({ data: hits, query: params.q, count: hits.length }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}