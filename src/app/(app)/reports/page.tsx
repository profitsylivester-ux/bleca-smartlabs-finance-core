import Link from 'next/link';
import { Card, CardBody, CardHeader, Badge } from '@/components/ui';
import { REPORTS, REPORT_CATEGORIES } from '@/lib/reports/registry';
import type { ReportCategory } from '@/lib/reports/types';

export const metadata = { title: 'Reports' };

function AvailabilityBadge({ availability }: { availability: 'AVAILABLE' | 'UNAVAILABLE' }) {
  if (availability === 'AVAILABLE') {
    return <Badge tone="success">Available</Badge>;
  }
  return <Badge tone="warning">Unavailable</Badge>;
}

export default async function ReportsPage() {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="Report registry" description="Browse and generate reports. Reports are computed server-side from the ledger — they cannot drift from the GL." />
        <CardBody>
          <div className="space-y-5">
            {REPORT_CATEGORIES.map((family) => {
              const reports = REPORTS.filter((r) => r.category === family.key);
              if (reports.length === 0) return null;
              return (
                <div key={family.key}>
                  <h3 className="mb-2 text-sm font-semibold">{family.label}</h3>
                  <div className="grid gap-3 md:grid-cols-2">
                    {reports.map((report) => (
                      <Link
                        key={report.key}
                        href={`/reports/${report.key}`}
                        className="rounded-lg border border-border p-4 hover:bg-surface-subtle"
                      >
                        <div className="flex items-center gap-2">
                          <h4 className="font-medium text-navy-800">{report.title}</h4>
                          <AvailabilityBadge availability={report.availability} />
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">{report.description}</p>
                        {report.availability === 'UNAVAILABLE' && report.unavailableReason && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            <i>{report.unavailableReason}</i>
                          </p>
                        )}
                      </Link>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
