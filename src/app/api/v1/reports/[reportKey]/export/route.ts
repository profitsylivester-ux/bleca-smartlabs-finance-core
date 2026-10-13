import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { computeReport } from '@/lib/reports/engine';
import { reportDefinition } from '@/lib/reports/registry';
import { writeAuditEntry } from '@/lib/audit/writer';
import { withAudit } from '@/lib/db/with-audit';
import { ValidationError, NotFoundError } from '@/lib/kernel/errors';
import type { ReportFilters, ReportResult, MarkedAmount } from '@/lib/reports/types';

const FILTER_KEYS: Array<keyof ReportFilters> = [
  'periodId', 'startDate', 'endDate', 'asAtDate',
  'projectId', 'departmentId', 'costCentreId', 'fundingSourceId', 'locationId',
  'currency', 'comparativePeriodId', 'comparativeDate', 'cadence',
];

function parseFilters(searchParams: URLSearchParams): ReportFilters {
  const filters: ReportFilters = {};
  for (const key of FILTER_KEYS) {
    const value = searchParams.get(key);
    if (value !== null) (filters as Record<string, unknown>)[key] = value;
  }
  return filters;
}

function isMarkedAmount(cell: unknown): cell is MarkedAmount {
  return typeof cell === 'object' && cell !== null && 'amount' in cell && 'currency' in cell;
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s: string;
  if (isMarkedAmount(value)) {
    s = value.unverified.length > 0 ? `${value.amount} ${value.currency} (UNVERIFIED)` : `${value.amount} ${value.currency}`;
  } else {
    s = String(value);
  }
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(report: ReportResult): string {
  const lines: string[] = [];
  lines.push(`Report,${csvEscape(report.title)}`);
  lines.push(`Report Key,${csvEscape(report.reportKey)}`);
  lines.push(`Currency,${csvEscape(report.currency)}`);
  lines.push(`Generated At,${csvEscape(report.generatedAt)}`);
  lines.push(`Has Unverified,${csvEscape(report.hasUnverified)}`);
  if (report.unavailableReason) lines.push(`Unavailable,${csvEscape(report.unavailableReason)}`);
  for (const section of report.sections) {
    lines.push('');
    lines.push(`Section,${csvEscape(section.label)}`);
    lines.push(section.columns.map((c) => csvEscape(c.label)).join(','));
    for (const row of section.rows) {
      lines.push(section.columns.map((c) => csvEscape(row.cells[c.key] ?? null)).join(','));
    }
  }
  return lines.join('\n');
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ reportKey: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'EXPORTS', action: 'EXPORT' });
    if (!ctx.actor.organizationId) return apiError(new ValidationError('No organization context'), reqId);

    const { reportKey } = await params;
    const { searchParams } = new URL(request.url);
    const format = (searchParams.get('format') ?? 'json').toLowerCase();

    if (!['json', 'csv', 'pdf', 'xlsx'].includes(format)) {
      return apiError(new ValidationError(`Unsupported format: ${format}`), reqId);
    }

    if (format === 'pdf' || format === 'xlsx') {
      return apiError(
        new ValidationError(
          `${format.toUpperCase()} export is declared but not yet implemented (needs pdf-lib/xlsx). Use JSON or CSV.`,
        ),
        reqId,
      );
    }

    const definition = reportDefinition(reportKey);
    if (!definition) return apiError(new NotFoundError('Report', reportKey), reqId);

    const filters = parseFilters(searchParams);
    const report = await computeReport(ctx, reportKey, filters);

    const h = await headers();
    const net = {
      ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
      userAgent: h.get('user-agent'),
      requestId: reqId,
    };

    await withAudit(
      {
        organizationId: ctx.actor.organizationId,
        actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
        ipAddress: net.ipAddress,
        userAgent: net.userAgent,
        requestId: reqId,
        sessionId: ctx.actor.sessionId,
      },
      async (tx) => {
        await writeAuditEntry(
          tx,
          { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
          {
            action: 'REPORT_GENERATED',
            entityType: 'EXPORT',
            entityId: reportKey,
            entityLabel: definition.title,
            description: `Exported ${definition.title} as ${format}`,
            changes: { format: { from: null, to: format } },
            metadata: { filters: JSON.parse(JSON.stringify(filters)), format, reportKey },
          },
          {
            organizationId: ctx.actor.organizationId,
            ipAddress: net.ipAddress,
            userAgent: net.userAgent,
            requestId: reqId,
            sessionId: ctx.actor.sessionId,
          },
        );
      },
    );

    if (format === 'csv') {
      return new NextResponse(toCsv(report), {
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="${reportKey}.csv"`,
          'x-request-id': reqId,
        },
      });
    }

    return ok({ data: report, exportedAt: new Date().toISOString(), format }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}



