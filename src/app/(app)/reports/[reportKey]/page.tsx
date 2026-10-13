import { headers } from 'next/headers';
import Link from 'next/link';
import { requireContext } from '@/lib/auth/guard';
import { computeReport } from '@/lib/reports/engine';
import { reportDefinition } from '@/lib/reports/registry';
import type { ReportCell, ReportFilters, MarkedAmount } from '@/lib/reports/types';

export const metadata = { title: 'Report' };

function isMarkedAmount(cell: ReportCell): cell is MarkedAmount {
  return typeof cell === 'object' && cell !== null && 'amount' in cell && 'currency' in cell;
}

function renderCell(cell: ReportCell) {
  if (cell === null || cell === undefined) return '';
  if (isMarkedAmount(cell)) {
    const unverified = cell.unverified.length > 0;
    return (
      <span className="inline-flex items-center gap-1">
        <span>{cell.amount} {cell.currency}</span>
        {unverified && (
          <span
            title={cell.unverified.map((u) => u.message).join(' | ')}
            className="rounded bg-red-100 px-1.5 py-0.5 text-xs font-semibold text-red-700"
          >
            UNVERIFIED
          </span>
        )}
      </span>
    );
  }
  if (typeof cell === 'boolean') return cell ? 'Yes' : 'No';
  return String(cell);
}

const FILTER_KEYS: Array<keyof ReportFilters> = [
  'periodId', 'startDate', 'endDate', 'asAtDate',
  'projectId', 'departmentId', 'costCentreId', 'fundingSourceId', 'locationId',
  'currency', 'comparativePeriodId', 'comparativeDate', 'cadence',
];

export default async function ReportDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ reportKey: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { reportKey } = await params;
  const sp = await searchParams;
  await headers();
  const ctx = await requireContext();

  const filters: ReportFilters = {};
  for (const key of FILTER_KEYS) {
    const v = sp[key];
    if (typeof v === 'string' && v.length > 0) {
      (filters as Record<string, unknown>)[key] = v;
    }
  }

  const definition = reportDefinition(reportKey);
  const report = await computeReport(ctx, reportKey, filters);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/reports" className="text-sm text-muted-foreground hover:underline">
          ← Back to reports
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">{report.title}</h1>
        {definition && <p className="mt-1 text-sm text-muted-foreground">{definition.description}</p>}
      </div>

      <form className="grid gap-3 rounded-lg border border-border p-4 md:grid-cols-3">
        {definition?.supportedFilters.map((key) => (
          <label key={key} className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-muted-foreground">{key}</span>
            <input
              type="text"
              name={key}
              defaultValue={(filters as Record<string, string | undefined>)[key] ?? ''}
              className="rounded border border-input px-2 py-1 text-sm"
            />
          </label>
        ))}
        <div className="flex items-end gap-2 md:col-span-3">
          <button type="submit" className="rounded bg-navy-800 px-3 py-1.5 text-sm text-white">
            Apply filters
          </button>
          <Link
            href={`/api/v1/reports/${reportKey}?format=json`}
            className="rounded border border-input px-3 py-1.5 text-sm"
          >
            JSON
          </Link>
          <Link
            href={`/api/v1/reports/${reportKey}?format=csv`}
            className="rounded border border-input px-3 py-1.5 text-sm"
          >
            CSV
          </Link>
        </div>
      </form>

      {report.unavailableReason && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <strong>Not yet available.</strong> {report.unavailableReason}
        </div>
      )}

      {report.hasUnverified && (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900">
          Some figures in this report come from unverified or historical records.
        </div>
      )}

      {report.sections.map((section) => (
        <div key={section.key} className="rounded-lg border border-border">
          <div className="border-b border-border px-4 py-2 text-sm font-semibold">{section.label}</div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-subtle">
                  {section.columns.map((col) => (
                    <th key={col.key} className="px-3 py-2 text-left font-medium">
                      {col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {section.rows.length === 0 ? (
                  <tr>
                    <td colSpan={section.columns.length} className="px-3 py-4 text-center text-muted-foreground">
                      No data.
                    </td>
                  </tr>
                ) : (
                  section.rows.map((row) => (
                    <tr key={row.id} className="border-b border-border last:border-0">
                      {section.columns.map((col) => (
                        <td key={col.key} className="px-3 py-2">
                          {renderCell(row.cells[col.key] ?? null)}
                        </td>
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {report.checks.length > 0 && (
        <div className="rounded-lg border border-border p-4">
          <h3 className="mb-2 text-sm font-semibold">Tie-out checks</h3>
          <ul className="space-y-1 text-sm">
            {report.checks.map((check) => (
              <li key={check.key}>
                <span className={check.passed ? 'text-green-700' : 'text-red-700'}>
                  {check.passed ? '✓' : '✗'}
                </span>{' '}
                {check.label} — <span className="text-muted-foreground">{check.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
