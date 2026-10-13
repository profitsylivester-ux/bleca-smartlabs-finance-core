import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import {
  REPORTS,
  REPORT_CATEGORIES,
} from '@/lib/reports/registry';
import type { ReportCategory, ReportDefinition } from '@/lib/reports/types';

export async function GET() {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'REPORTS', action: 'VIEW' });
    if (!ctx.actor.organizationId) {
      return apiError(new Error('No organization context'), reqId);
    }
    const categories = REPORT_CATEGORIES.map((family) => ({
      key: family.key as ReportCategory,
      label: family.label,
      reports: REPORTS.filter((r) => r.category === family.key).map((r) => ({
        key: r.key,
        title: r.title,
        description: r.description,
        availability: r.availability,
        unavailableReason: r.availability === 'UNAVAILABLE' ? r.unavailableReason : undefined,
      })),
    }));
    return ok(
      {
        reportKey: 'registry',
        generatedAt: new Date().toISOString(),
        currency: null,
        categories,
        reports: REPORTS.map((r) => ({
          ...r,
          supportedFilters: r.supportedFilters,
        })),
      },
      200,
      reqId,
    );
  } catch (error) {
    return apiError(error, reqId);
  }
}

