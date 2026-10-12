'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Card, CardBody, CardHeader, Table, Td, Th } from '@/components/ui';

interface ComplianceReport {
  credentials: Array<{ id: string; title: string; status: string; expiryDate: string | null }>;
  expiringCredentials: Array<{ id: string; title: string; status: string; expiryDate: string | null }>;
  obligations: Array<{ id: string; period: string; status: string; filingDueDate: string | null }>;
  unverifiedRules: Array<{ id: string; code: string; name: string; jurisdiction: string }>;
}

export default function ComplianceReportClient() {
  const [report, setReport] = useState<ComplianceReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/v1/reports/compliance');
      const result = await response.json() as { data?: ComplianceReport; error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message ?? 'Could not load compliance report.');
      setReport(result.data ?? null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load compliance report.'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return <div className="space-y-5">{error && <Alert tone="danger" title="Report failed">{error}</Alert>}
    <Card><CardHeader title="Compliance status" description="Overdue obligations, expiring credentials and unverified rules." /><CardBody>{report && <div className="space-y-6">
      {report.unverifiedRules.length > 0 && <Alert tone="warning" title="Unverified tax rules">{report.unverifiedRules.length} rule(s) await accountant sign-off. Figures that use them are not trusted.</Alert>}
      <div><h3 className="mb-2 text-sm font-semibold">Obligations</h3><Table><thead><tr><Th>Period</Th><Th>Status</Th><Th>Due</Th></tr></thead><tbody>{report.obligations.map((row) => <tr key={row.id}><Td className="font-medium">{row.period}</Td><Td><Badge tone={row.status === 'OVERDUE' ? 'danger' : row.status === 'PAID' ? 'success' : 'neutral'}>{row.status}</Badge></Td><Td>{row.filingDueDate?.slice(0, 10) ?? '—'}</Td></tr>)}</tbody></Table></div>
      <div><h3 className="mb-2 text-sm font-semibold">Expiring credentials</h3><Table><thead><tr><Th>Credential</Th><Th>Status</Th><Th>Expiry</Th></tr></thead><tbody>{report.expiringCredentials.map((row) => <tr key={row.id}><Td className="font-medium">{row.title}</Td><Td><Badge tone={row.status === 'EXPIRED' ? 'danger' : 'warning'}>{row.status}</Badge></Td><Td>{row.expiryDate?.slice(0, 10) ?? '—'}</Td></tr>)}</tbody></Table></div>
    </div>}</CardBody></Card></div>;
}
