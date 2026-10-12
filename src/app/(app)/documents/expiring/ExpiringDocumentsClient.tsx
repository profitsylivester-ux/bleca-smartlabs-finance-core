'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Alert, Badge, Card, CardBody, CardHeader, EmptyState, Table, Td, Th } from '@/components/ui';

type ExpiringDocument = { id: string; title: string; category: string; status: string; expiryDate: string | null; renewalDueAt: string | null; fileName: string };

export default function ExpiringDocumentsClient() {
  const [rows, setRows] = useState<ExpiringDocument[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const now = new Date();
    const until = new Date(now);
    until.setDate(until.getDate() + 90);
    const params = new URLSearchParams({ expiryFrom: now.toISOString(), expiryTo: until.toISOString(), limit: '100' });
    void fetch(`/api/v1/documents?${params.toString()}`)
      .then(async (response) => {
        const result = await response.json() as { data?: ExpiringDocument[]; error?: { message?: string } };
        if (!response.ok) throw new Error(result.error?.message ?? 'Could not load expiring documents.');
        setRows(result.data ?? []);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Could not load expiring documents.'))
      .finally(() => setLoading(false));
  }, []);

  return <div className="space-y-5">
    <Link className="text-sm text-navy-700 hover:underline" href="/documents">← Document library</Link>
    {error && <Alert tone="danger" title="Could not load expiry dates">{error}</Alert>}
    <Card><CardHeader title="Expiring in the next 90 days" description="Review the document, contact its owner, and record a replacement as a renewal." /><CardBody>
      {loading ? <p className="py-8 text-center text-sm text-muted-foreground">Loading expiry dates…</p> : rows.length === 0 ? <EmptyState title="No upcoming expiries" body="Documents expiring in the next 90 days will appear here." /> : <Table><thead><tr><Th>Document</Th><Th>Category</Th><Th>Status</Th><Th>Expires</Th><Th>Renewal due</Th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><Td><Link className="font-medium text-navy-700 hover:underline" href={`/documents/${row.id}`}>{row.title}</Link><div className="text-xs text-muted-foreground">{row.fileName}</div></Td><Td>{row.category.replaceAll('_', ' ')}</Td><Td><Badge tone={row.status === 'APPROVED' ? 'success' : 'warning'}>{row.status.replaceAll('_', ' ')}</Badge></Td><Td>{row.expiryDate ? new Date(row.expiryDate).toLocaleDateString() : '—'}</Td><Td>{row.renewalDueAt ? new Date(row.renewalDueAt).toLocaleDateString() : '—'}</Td></tr>)}</tbody></Table>}
    </CardBody></Card>
  </div>;
}
