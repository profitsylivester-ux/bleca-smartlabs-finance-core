'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Alert, Badge, Button, Card, CardBody, CardHeader, EmptyState, Input, Select, SelectOption, Table, Td, Th } from '@/components/ui';

type DocumentRow = {
  id: string;
  title: string;
  description: string | null;
  category: string;
  status: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  currentVersion: number;
  expiryDate: string | null;
  renewalDueAt: string | null;
  ocrStatus: string;
  tags: Array<{ tag: { id: string; name: string } }>;
  links: Array<{ id: string; entityType: string; entityId: string; linkType: string; isPrimary: boolean }>;
};

const categories = [
  'RECEIPT', 'INVOICE', 'QUOTATION', 'CONTRACT', 'GRANT_DOCUMENT', 'TAX_DOCUMENT', 'COMPLIANCE_DOCUMENT',
  'FINANCIAL_EVIDENCE', 'ASSET_DOCUMENT', 'SUPPLIER_DOCUMENT', 'CUSTOMER_DOCUMENT', 'BANK_STATEMENT',
  'RECONCILIATION_SUPPORT', 'OTHER',
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function pretty(value: string): string {
  return value.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export default function DocumentsClient({ canConfigure = false }: { canConfigure?: boolean }) {
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('');
  const [tag, setTag] = useState('');
  const [layout, setLayout] = useState<'grid' | 'list'>('grid');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (query.trim()) params.set('q', query.trim());
    if (category) params.set('category', category);
    if (status) params.set('status', status);
    if (tag.trim()) params.set('tag', tag.trim());
    try {
      const response = await fetch(`/api/v1/documents?${params.toString()}`);
      const result = await response.json() as { data?: DocumentRow[]; error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message ?? 'Could not load documents.');
      setDocuments(result.data ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load documents.');
    } finally {
      setLoading(false);
    }
  }, [query, category, status, tag]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-5">
      {error && <Alert tone="danger" title="Document request failed">{error}</Alert>}
      <Card>
        <CardHeader
          title="Document library"
          description="Private evidence files, classification, expiry dates and linked records."
          actions={<div className="flex flex-wrap items-center gap-3"><Link className="text-sm text-navy-700 hover:underline" href="/documents/expiring">Expiring soon</Link>{canConfigure && <Link className="text-sm text-navy-700 hover:underline" href="/documents/retention">Retention settings</Link>}<Link href="/documents/upload"><Button>Upload document</Button></Link></div>}
         actions={<Link href="/documents/upload" className="bg-navy-800 text-white rounded-md px-4 py-2 text-sm font-medium hover:bg-navy-700">+ Upload Document</Link>} />
        <CardBody>
          <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Input aria-label="Search documents" placeholder="Search title, description or OCR text" value={query} onChange={(event) => setQuery(event.target.value)} />
            <Select aria-label="Filter document category" value={category} onChange={(event) => setCategory(event.target.value)}>
              <SelectOption value="">All categories</SelectOption>
              {categories.map((value) => <SelectOption key={value} value={value}>{pretty(value)}</SelectOption>)}
            </Select>
            <Select aria-label="Filter document status" value={status} onChange={(event) => setStatus(event.target.value)}>
              <SelectOption value="">All statuses</SelectOption>
              {['AVAILABLE', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'ARCHIVED'].map((value) => <SelectOption key={value} value={value}>{pretty(value)}</SelectOption>)}
            </Select>
            <div className="flex gap-2"><Input aria-label="Filter by tag" placeholder="Tag name" value={tag} onChange={(event) => setTag(event.target.value)} /><Button variant="outline" onClick={() => setLayout((value) => value === 'grid' ? 'list' : 'grid')}>{layout === 'grid' ? 'List view' : 'Grid view'}</Button></div>
          </div>
          {loading ? <p className="py-8 text-center text-sm text-muted-foreground">Loading documents…</p> : documents.length === 0 ? (
            <EmptyState title="No documents found" body="Adjust the filters or upload a document to start the evidence library." />
          ) : layout === 'list' ? (
            <Table>
              <thead><tr><Th>Document</Th><Th>Category</Th><Th>Status</Th><Th>File</Th><Th>Expires</Th><Th>Tags</Th></tr></thead>
              <tbody>{documents.map((document) => <tr key={document.id}>
                <Td><Link className="font-medium text-navy-700 hover:underline" href={`/documents/${document.id}`}>{document.title}</Link><div className="text-xs text-muted-foreground">Version {document.currentVersion}</div></Td>
                <Td>{pretty(document.category)}</Td><Td><Badge tone={document.status === 'APPROVED' ? 'success' : document.status === 'PENDING_APPROVAL' ? 'warning' : 'neutral'}>{pretty(document.status)}</Badge></Td>
                <Td>{formatBytes(document.fileSize)} · {document.mimeType.split('/')[1]?.toUpperCase()}</Td><Td>{document.expiryDate ? new Date(document.expiryDate).toLocaleDateString() : '—'}</Td>
                <Td>{document.tags.map((entry) => entry.tag.name).join(', ') || '—'}</Td>
              </tr>)}</tbody>
            </Table>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {documents.map((document) => <Link key={document.id} href={`/documents/${document.id}`} className="rounded-xl border border-border p-4 transition hover:border-navy-300 hover:bg-muted/30">
                <div className="flex items-start justify-between gap-3"><h2 className="font-semibold text-foreground">{document.title}</h2><Badge tone={document.status === 'APPROVED' ? 'success' : document.status === 'PENDING_APPROVAL' ? 'warning' : 'neutral'}>{pretty(document.status)}</Badge></div>
                <p className="mt-2 line-clamp-2 min-h-10 text-sm text-muted-foreground">{document.description || document.fileName}</p>
                <div className="mt-4 flex flex-wrap gap-2 text-xs text-muted-foreground"><span>{pretty(document.category)}</span><span>·</span><span>{formatBytes(document.fileSize)}</span><span>·</span><span>v{document.currentVersion}</span></div>
                <div className="mt-3 flex flex-wrap gap-1">{document.tags.map((entry) => <Badge key={entry.tag.id} tone="info">{entry.tag.name}</Badge>)}</div>
                <p className="mt-3 text-xs text-muted-foreground">{document.expiryDate ? `Expires ${new Date(document.expiryDate).toLocaleDateString()}` : 'No expiry date'}</p>
              </Link>)}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
