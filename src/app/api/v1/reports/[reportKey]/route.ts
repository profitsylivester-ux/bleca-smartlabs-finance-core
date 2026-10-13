import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { computeReport } from '@/lib/reports/engine';
import type { ReportFilters } from '@/lib/reports/types';

const FILTER_KEYS: Array<keyof ReportFilters> = [
  'periodId',
  'startDate',
  'endDate',
  'asAtDate',
  'projectId',
  'departmentId',
  'costCentreId',
  'fundingSourceId',
  'locationId',
  'currency',
  'comparativePeriodId',
  'comparativeDate',
  'cadence',
];

function parseFilter(value: string | null): string | undefined {
  return value ?? undefined;
}

function parseFilters(searchParams: URLSearchParams): ReportFilters {
  const filters: ReportFilters = {};
  for (const key of FILTER_KEYS) {
    const value = searchParams.get(key);
    if (value !== null) {
      (filters as Record<string, unknown>)[key] = value;
    }
  }
  return filters as ReportFilters;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ reportKey: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'REPORTS', action: 'VIEW' });
    if (!ctx.actor.organizationId) {
      return apiError(new Error('No organization context'), reqId);
    }
    const { reportKey } = await params;
    const { searchParams } = new URL(request.url);
    const filters = parseFilters(searchParams);
    const report = await computeReport(ctx, reportKey, filters);
    return ok({ data: report }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}
