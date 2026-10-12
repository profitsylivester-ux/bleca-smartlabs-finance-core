'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Alert, Button, Card, CardBody, CardHeader, Input, Select, SelectOption } from '@/components/ui';

const categories = [
  'RECEIPT', 'INVOICE', 'QUOTATION', 'CONTRACT', 'GRANT_DOCUMENT', 'TAX_DOCUMENT', 'COMPLIANCE_DOCUMENT',
  'FINANCIAL_EVIDENCE', 'ASSET_DOCUMENT', 'SUPPLIER_DOCUMENT', 'CUSTOMER_DOCUMENT', 'BANK_STATEMENT',
  'RECONCILIATION_SUPPORT', 'OTHER',
];

export default function DocumentUploadClient() {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step === 1) {
      const form = new FormData(event.currentTarget);
      if (!form.get('file')) { setError('Choose a PDF, JPEG or PNG file first.'); return; }
      if (!String(form.get('title') ?? '').trim()) { setError('Add a document title before continuing.'); return; }
      setError(null);
      setStep(2);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const data = new FormData(formRef.current ?? undefined);
      const metadata = String(data.get('metadata') ?? '').trim();
      if (metadata) JSON.parse(metadata);
      const response = await fetch('/api/v1/documents/upload', { method: 'POST', body: data });
      const result = await response.json() as { data?: { id?: string }; deduplicated?: boolean; error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message ?? 'Could not upload document.');
      if (result.data?.id) router.push(`/documents/${result.data.id}`);
      else router.push('/documents');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not upload document.');
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Link className="text-sm text-navy-700 hover:underline" href="/documents">← Document library</Link>
      {error && <Alert tone="danger" title="Upload could not continue">{error}</Alert>}
      <Card>
        <CardHeader title="Upload a document" description={`Step ${step} of 2 · Files stay private and every upload is recorded in the audit trail.`} />
        <CardBody>
          <form ref={formRef} onSubmit={submit} className="space-y-5">
            <div className={step === 1 ? 'space-y-5' : 'hidden'}>
              <label className="block space-y-2 text-sm font-medium">PDF or image file<input className="block w-full rounded-lg border border-border bg-background p-3 text-sm" name="file" type="file" accept="application/pdf,image/*" required /></label>
              <Input name="title" aria-label="Document title" placeholder="Document title" required maxLength={200} />
              <Select name="category" aria-label="Document category" defaultValue="FINANCIAL_EVIDENCE">
                {categories.map((value) => <SelectOption key={value} value={value}>{value.replaceAll('_', ' ')}</SelectOption>)}
              </Select>
            </div>
            <div className={step === 2 ? 'space-y-5' : 'hidden'}>
              <p className="rounded-lg bg-muted/40 p-3 text-sm text-muted-foreground">Add optional record details. The document hash is checked for duplicates before storage.</p>
              <label className="block space-y-2 text-sm font-medium">Description<textarea className="min-h-24 w-full rounded-lg border border-border bg-background p-3 text-sm" name="description" maxLength={5000} /></label>
              <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-2 text-sm font-medium">Expires on<input className="block w-full rounded-lg border border-border bg-background p-2.5" name="expiryDate" type="date" /></label><label className="space-y-2 text-sm font-medium">Renewal due<input className="block w-full rounded-lg border border-border bg-background p-2.5" name="renewalDueAt" type="date" /></label></div>
              <label className="block space-y-2 text-sm font-medium">Metadata (JSON)<textarea className="min-h-24 w-full rounded-lg border border-border bg-background p-3 font-mono text-sm" name="metadata" defaultValue="{}" /></label>
            </div>
            <div className="flex justify-between gap-3 border-t border-border pt-4">
              <div>{step === 2 && <Button type="button" variant="outline" onClick={() => setStep(1)} disabled={busy}>Back</Button>}</div>
              <Button type="submit" disabled={busy}>{busy ? 'Uploading…' : step === 1 ? 'Continue' : 'Upload document'}</Button>
            </div>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
