'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Input, Select, SelectOption } from '@/components/ui';

type DocumentDetail = {
  id: string;
  title: string;
  description: string | null;
  category: string;
  status: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  currentVersion: number;
  metadata: unknown;
  expiryDate: string | null;
  renewalDueAt: string | null;
  renewalOfId: string | null;
  renewalOf: { id: string; title: string; expiryDate: string | null } | null;
  renewals: Array<{ id: string; title: string; expiryDate: string | null; status: string }>;
  ocrStatus: string;
  ocrText: string | null;
  versions: Array<{ id: string; version: number; fileName: string; fileSize: number; reason: string; createdAt: string; createdById: string }>;
  tags: Array<{ tag: { id: string; name: string } }>;
  links: Array<{ id: string; entityType: string; entityId: string; linkType: string; isPrimary: boolean }>;
  legalHolds: Array<{ id: string; reason: string; approvedById: string; placedAt: string; releasedAt: string | null; releaseReason: string | null }>;
  retentionPolicy: { name: string; retentionMonths: number; action: string; legalBasis: string } | null;
  approvalRequest: { id: string; status: string; submittedAt: string; decidedAt: string | null } | null;
};

const categories = [
  'RECEIPT', 'INVOICE', 'QUOTATION', 'CONTRACT', 'GRANT_DOCUMENT', 'TAX_DOCUMENT', 'COMPLIANCE_DOCUMENT',
  'FINANCIAL_EVIDENCE', 'ASSET_DOCUMENT', 'SUPPLIER_DOCUMENT', 'CUSTOMER_DOCUMENT', 'BANK_STATEMENT',
  'RECONCILIATION_SUPPORT', 'OTHER',
];
const entityTypes = ['TRANSACTION', 'INVOICE', 'PAYMENT', 'RECEIPT', 'QUOTATION', 'SUPPLIER', 'CUSTOMER', 'PROJECT', 'FUNDING_SOURCE', 'JOURNAL_ENTRY', 'TREASURY_ACCOUNT', 'BUDGET', 'RECONCILIATION_SESSION'];
const linkTypes = ['EVIDENCE', 'SUPPORTING', 'PRIMARY', 'CONTRACT', 'AMENDMENT'];

function toDateInput(value: string | null): string {
  return value ? new Date(value).toISOString().slice(0, 10) : '';
}

function metadataText(value: unknown): string {
  return value === null ? '{}' : JSON.stringify(value, null, 2);
}

export default function DocumentDetailClient({ documentId, roleCodes }: { documentId: string; roleCodes: string[] }) {
  const router = useRouter();
  const [document, setDocument] = useState<DocumentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('OTHER');
  const [metadata, setMetadata] = useState('{}');
  const [expiryDate, setExpiryDate] = useState('');
  const [renewalDueAt, setRenewalDueAt] = useState('');
  const [renewalOfId, setRenewalOfId] = useState('');
  const [tagName, setTagName] = useState('');
  const [entityType, setEntityType] = useState('TRANSACTION');
  const [entityId, setEntityId] = useState('');
  const [linkType, setLinkType] = useState('EVIDENCE');
  const [versionReason, setVersionReason] = useState('');
  const [versionFile, setVersionFile] = useState<File | null>(null);
  const [holdReason, setHoldReason] = useState('');
  const [decisionReason, setDecisionReason] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/documents/${documentId}`);
      const result = await response.json() as { data?: DocumentDetail; error?: { message?: string } };
      if (!response.ok || !result.data) throw new Error(result.error?.message ?? 'Could not load document.');
      setDocument(result.data);
      setTitle(result.data.title);
      setDescription(result.data.description ?? '');
      setCategory(result.data.category);
      setMetadata(metadataText(result.data.metadata));
      setExpiryDate(toDateInput(result.data.expiryDate));
      setRenewalDueAt(toDateInput(result.data.renewalDueAt));
      setRenewalOfId(result.data.renewalOfId ?? '');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load document.');
    } finally {
      setLoading(false);
    }
  }, [documentId]);

  useEffect(() => { void load(); }, [load]);

  async function jsonRequest(url: string, method: string, body?: unknown) {
    setError(null);
    setNotice(null);
    const response = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json() as { error?: { message?: string } };
    if (!response.ok) throw new Error(result.error?.message ?? 'The document action could not be completed.');
    await load();
  }

  async function saveMetadata(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      await jsonRequest(`/api/v1/documents/${documentId}`, 'PATCH', {
        title, description: description || null, category,
        metadata: JSON.parse(metadata),
        expiryDate: expiryDate ? new Date(`${expiryDate}T00:00:00.000Z`).toISOString() : null,
        renewalDueAt: renewalDueAt ? new Date(`${renewalDueAt}T00:00:00.000Z`).toISOString() : null,
        renewalOfId: renewalOfId || null,
      });
      setNotice('Document details saved.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save document details.'); }
  }

  async function openPreview() {
    setError(null);
    try {
      const response = await fetch(`/api/v1/documents/${documentId}/download-url`);
      const result = await response.json() as { data?: { signedUrl: string }; error?: { message?: string } };
      if (!response.ok || !result.data) throw new Error(result.error?.message ?? 'Could not create a preview link.');
      setPreviewUrl(result.data.signedUrl);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create a preview link.'); }
  }

  async function uploadVersion(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!versionFile || !versionReason.trim()) { setError('Choose a file and explain why this version is being added.'); return; }
    const form = new FormData();
    form.set('file', versionFile);
    form.set('title', title);
    form.set('category', category);
    form.set('reason', versionReason);
    try {
      const response = await fetch(`/api/v1/documents/${documentId}/versions`, { method: 'POST', body: form });
      const result = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message ?? 'Could not upload a new version.');
      setVersionFile(null);
      setVersionReason('');
      setNotice('New version added to the immutable version history.');
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not upload a new version.'); }
  }

  async function addTag(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      await jsonRequest(`/api/v1/documents/${documentId}/tags`, 'POST', { name: tagName });
      setTagName(''); setNotice('Tag applied.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not apply the tag.'); }
  }

  async function addLink(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      await jsonRequest(`/api/v1/documents/${documentId}/links`, 'POST', { entityType, entityId, linkType });
      setEntityId(''); setNotice('Document linked to the record.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not link the document.'); }
  }

  async function requestApproval() {
    try {
      await jsonRequest(`/api/v1/documents/${documentId}/approve`, 'POST', { action: 'SUBMIT' });
      setNotice('Approval request submitted.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not submit for approval.'); }
  }

  async function decideApproval(action: 'APPROVE' | 'REJECT') {
    if (!document?.approvalRequest || !decisionReason.trim()) { setError('Enter a reason for the approval decision.'); return; }
    try {
      await jsonRequest(`/api/v1/documents/${documentId}/approve`, 'POST', {
        action, requestId: document.approvalRequest.id, reason: decisionReason,
      });
      setDecisionReason(''); setNotice(`Document ${action.toLowerCase()}d.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : `Could not ${action.toLowerCase()} document.`); }
  }

  async function placeHold(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      await jsonRequest(`/api/v1/documents/${documentId}/legal-hold`, 'POST', { reason: holdReason });
      setHoldReason(''); setNotice('Legal hold placed and audit recorded.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not place legal hold.'); }
  }

  async function releaseHold(holdId: string) {
    const reason = window.prompt('Reason for releasing this legal hold');
    if (!reason?.trim()) return;
    try {
      await jsonRequest(`/api/v1/legal-holds/${holdId}/release`, 'POST', { reason });
      setNotice('Legal hold released and audit recorded.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not release legal hold.'); }
  }

  async function deleteDocument() {
    if (!window.confirm('Move this document to the archive? An active legal hold will block the action.')) return;
    try {
      await jsonRequest(`/api/v1/documents/${documentId}`, 'DELETE');
      router.push('/documents');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not archive the document.'); }
  }

  if (loading) return <p className="py-8 text-center text-sm text-muted-foreground">Loading document…</p>;
  if (!document) return <div className="space-y-4">{error && <Alert tone="danger" title="Document unavailable">{error}</Alert>}<Link className="text-sm text-navy-700 hover:underline" href="/documents">← Document library</Link></div>;

  const activeHolds = document.legalHolds.filter((hold) => !hold.releasedAt);
  const canApprove = roleCodes.includes('CEO');

  return <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><Link className="text-sm text-navy-700 hover:underline" href="/documents">← Document library</Link><h1 className="mt-2 text-2xl font-semibold">{document.title}</h1><p className="mt-1 text-sm text-muted-foreground">{document.fileName} · Version {document.currentVersion} · {document.status.replaceAll('_', ' ')}</p></div><div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => void openPreview()}>Preview</Button><Button variant="outline" onClick={() => void requestApproval()}>Request approval</Button><Button variant="outline" onClick={() => void deleteDocument()}>Archive</Button></div></div>
    {error && <Alert tone="danger" title="Document action failed">{error}</Alert>}{notice && <Alert tone="success" title="Document updated">{notice}</Alert>}
    {previewUrl && <Card><CardHeader title="Private preview" actions={<Button variant="outline" size="sm" onClick={() => setPreviewUrl(null)}>Close preview</Button>} /><CardBody><iframe className="h-[70vh] w-full rounded-lg border border-border" src={previewUrl} title={`Preview of ${document.title}`} /></CardBody></Card>}
    {document.status === 'PENDING_APPROVAL' && document.approvalRequest && <Card><CardHeader title="Approval workflow" description={`Request ${document.approvalRequest.id} · ${document.approvalRequest.status.replaceAll('_', ' ')}`} /><CardBody className="space-y-3"><Input aria-label="Approval decision reason" placeholder="Reason for decision" value={decisionReason} onChange={(event) => setDecisionReason(event.target.value)} />{canApprove && <div className="flex gap-2"><Button onClick={() => void decideApproval('APPROVE')}>Approve</Button><Button variant="outline" onClick={() => void decideApproval('REJECT')}>Reject</Button></div>}<p className="text-xs text-muted-foreground">The approval engine enforces assigned approvers and prevents self-approval.</p></CardBody></Card>}
    <div className="grid gap-5 xl:grid-cols-2">
      <Card><CardHeader title="Metadata" description="Classification, searchable JSON metadata, expiry and renewal dates." /><CardBody><form className="space-y-3" onSubmit={saveMetadata}>
        <Input aria-label="Document title" value={title} onChange={(event) => setTitle(event.target.value)} required />
        <Select aria-label="Document category" value={category} onChange={(event) => setCategory(event.target.value)}>{categories.map((value) => <SelectOption key={value} value={value}>{value.replaceAll('_', ' ')}</SelectOption>)}</Select>
        <label className="block space-y-2 text-sm font-medium">Description<textarea className="min-h-20 w-full rounded-lg border border-border bg-background p-3 text-sm" value={description} onChange={(event) => setDescription(event.target.value)} /></label>
        <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-2 text-sm font-medium">Expiry<input className="block w-full rounded-lg border border-border bg-background p-2.5" type="date" value={expiryDate} onChange={(event) => setExpiryDate(event.target.value)} /></label><label className="space-y-2 text-sm font-medium">Renewal due<input className="block w-full rounded-lg border border-border bg-background p-2.5" type="date" value={renewalDueAt} onChange={(event) => setRenewalDueAt(event.target.value)} /></label></div>
        <Input aria-label="Renewal of document ID" placeholder="Renewal of document ID (optional)" value={renewalOfId} onChange={(event) => setRenewalOfId(event.target.value)} />
        <label className="block space-y-2 text-sm font-medium">Free-text metadata (JSON)<textarea className="min-h-28 w-full rounded-lg border border-border bg-background p-3 font-mono text-sm" value={metadata} onChange={(event) => setMetadata(event.target.value)} /></label>
        <div className="flex items-center justify-between"><span className="text-xs text-muted-foreground">OCR status: {document.ocrStatus}{document.ocrText ? ` · ${document.ocrText.slice(0, 100)}` : ''}</span><Button type="submit">Save metadata</Button></div>
      </form></CardBody></Card>
      <Card><CardHeader title="Retention and legal holds" description="Retention policy applies by document category. Active holds prevent archival and deletion." /><CardBody className="space-y-4">
        {document.renewalOf && <p className="text-sm">Renewal of <Link className="text-navy-700 hover:underline" href={`/documents/${document.renewalOf.id}`}>{document.renewalOf.title}</Link></p>}
        {document.renewals.length > 0 && <div className="text-sm"><div className="font-medium">Renewed by</div><ul className="mt-1 list-disc pl-5">{document.renewals.map((renewal) => <li key={renewal.id}><Link className="text-navy-700 hover:underline" href={`/documents/${renewal.id}`}>{renewal.title}</Link> · {renewal.status.replaceAll('_', ' ')}</li>)}</ul></div>}
        {document.retentionPolicy ? <div className="rounded-lg border border-border p-3 text-sm"><div className="font-medium">{document.retentionPolicy.name}</div><p className="mt-1 text-muted-foreground">{document.retentionPolicy.action.replaceAll('_', ' ')} after {document.retentionPolicy.retentionMonths} months</p><p className="mt-1 text-xs text-muted-foreground">{document.retentionPolicy.legalBasis}</p></div> : <p className="text-sm text-muted-foreground">No active retention policy for this category.</p>}
        {activeHolds.length > 0 ? activeHolds.map((hold) => <div key={hold.id} className="rounded-lg border border-danger-200 bg-danger-50 p-3 text-sm"><div className="font-semibold text-danger-800">Active legal hold</div><p className="mt-1 text-danger-800">{hold.reason}</p><p className="mt-1 text-xs text-danger-700">Approved by {hold.approvedById} · {new Date(hold.placedAt).toLocaleDateString()}</p>{canApprove && <Button className="mt-3" variant="outline" size="sm" onClick={() => void releaseHold(hold.id)}>Release hold</Button>}</div>) : <p className="text-sm text-muted-foreground">No active legal hold.</p>}
        {canApprove && <form className="flex gap-2" onSubmit={placeHold}><Input aria-label="Legal hold reason" placeholder="Reason for legal hold" value={holdReason} onChange={(event) => setHoldReason(event.target.value)} required minLength={5} /><Button type="submit" variant="outline">Place hold</Button></form>}
      </CardBody></Card>
    </div>
    <div className="grid gap-5 xl:grid-cols-2">
      <Card><CardHeader title="Version history" description="Each version is stored independently and cannot be edited or removed." /><CardBody className="space-y-4">
        <form onSubmit={uploadVersion} className="grid gap-3 rounded-lg border border-border p-3"><label className="text-sm font-medium">Upload a new PDF or image version<input className="mt-2 block w-full text-sm" type="file" accept="application/pdf,image/*" onChange={(event) => setVersionFile(event.target.files?.[0] ?? null)} /></label><Input aria-label="Version reason" placeholder="Reason for this version" value={versionReason} onChange={(event) => setVersionReason(event.target.value)} required /><Button type="submit" className="justify-self-start">Add version</Button></form>
        <ol className="space-y-3">{document.versions.map((version) => <li key={version.id} className="flex justify-between gap-3 border-b border-border pb-3 text-sm"><div><div className="font-medium">Version {version.version} · {version.fileName}</div><p className="mt-1 text-muted-foreground">{version.reason}</p></div><time className="shrink-0 text-xs text-muted-foreground">{new Date(version.createdAt).toLocaleString()}</time></li>)}</ol>
      </CardBody></Card>
      <Card><CardHeader title="Tags and linked records" description="Use links to connect this evidence to transactions and other business records." /><CardBody className="space-y-5">
        <form className="flex gap-2" onSubmit={addTag}><Input aria-label="New document tag" placeholder="Tag name" value={tagName} onChange={(event) => setTagName(event.target.value)} required /><Button type="submit" variant="outline">Apply tag</Button></form>
        <div className="flex flex-wrap gap-2">{document.tags.map(({ tag }) => <Badge key={tag.id} tone="info">{tag.name}<button className="ml-2 text-xs" aria-label={`Remove tag ${tag.name}`} onClick={() => void jsonRequest(`/api/v1/documents/${documentId}/tags/${tag.id}`, 'DELETE')}>×</button></Badge>)}</div>
        <form className="grid gap-2 sm:grid-cols-2" onSubmit={addLink}><Select aria-label="Linked record type" value={entityType} onChange={(event) => setEntityType(event.target.value)}>{entityTypes.map((value) => <SelectOption key={value} value={value}>{value.replaceAll('_', ' ')}</SelectOption>)}</Select><Input aria-label="Linked record ID" placeholder="Record ID" value={entityId} onChange={(event) => setEntityId(event.target.value)} required /><Select aria-label="Link type" value={linkType} onChange={(event) => setLinkType(event.target.value)}>{linkTypes.map((value) => <SelectOption key={value} value={value}>{value}</SelectOption>)}</Select><Button type="submit" variant="outline">Link record</Button></form>
        <ul className="space-y-2">{document.links.map((link) => <li key={link.id} className="flex items-center justify-between gap-2 rounded-lg border border-border p-3 text-sm"><span>{link.entityType.replaceAll('_', ' ')} · {link.entityId} · {link.linkType}{link.isPrimary ? ' · Primary' : ''}</span><button className="text-xs text-danger-700 hover:underline" onClick={() => void jsonRequest(`/api/v1/documents/${documentId}/links/${link.id}`, 'DELETE')}>Remove</button></li>)}</ul>
      </CardBody></Card>
    </div>
  </div>;
}
