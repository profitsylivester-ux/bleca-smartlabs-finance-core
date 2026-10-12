'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Alert, Badge, Button, Card, CardBody, CardHeader, EmptyState, Input, Select, SelectOption, Table, Td, Th } from '@/components/ui';
import { formatDate } from '@/lib/format';

type BankDetail = { id: string; bankName: string; accountHolderName: string; accountNumberLast4: string; branchName: string | null; currencyCode: string | null; isPrimary: boolean; isActive: boolean; effectiveFrom: string; effectiveTo: string | null };
type Snapshot = { bankName: string | null; accountHolderName: string | null; accountNumberLast4: string | null; branchName: string | null; currencyCode: string | null } | null;
type Change = { id: string; status: string; requestedById: string; verifierId: string | null; approverId: string | null; evidenceDocumentId: string; requestedAt: string; verifiedAt: string | null; decidedAt: string | null; verificationNotes: string | null; decisionReason: string | null; previousValues: Snapshot; proposedValues: Snapshot };

export default function SupplierBankDetailsClient({ id }: { id: string }) {
  const [bankDetails, setBankDetails] = useState<BankDetail[]>([]);
  const [changes, setChanges] = useState<Change[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [bankName, setBankName] = useState('');
  const [accountHolderName, setAccountHolderName] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [branchName, setBranchName] = useState('');
  const [swiftCode, setSwiftCode] = useState('');
  const [iban, setIban] = useState('');
  const [currencyCode, setCurrencyCode] = useState('');
  const [evidenceDocumentId, setEvidenceDocumentId] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const response = await fetch(`/api/v1/suppliers/${id}/bank-details`);
      const result = await response.json() as { data?: { bankDetails: BankDetail[]; changes: Change[] }; error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message ?? 'Could not load bank details.');
      setBankDetails(result.data?.bankDetails ?? []); setChanges(result.data?.changes ?? []);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load bank details.'); }
    finally { setLoading(false); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  async function submitChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError(null); setNotice(null);
    try {
      const response = await fetch(`/api/v1/suppliers/${id}/bank-details`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({ bankName, accountHolderName, accountNumber, branchName: branchName || undefined, swiftCode: swiftCode || undefined, iban: iban || undefined, currencyCode: currencyCode || undefined, evidenceDocumentId }),
      });
      const result = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message ?? 'Could not submit the bank detail change.');
      setAccountNumber(''); setEvidenceDocumentId(''); setNotice('Change request submitted. Payments are blocked until approval or rejection.'); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not submit the change.'); }
    finally { setSaving(false); }
  }

  async function decide(changeId: string, stage: 'verify' | 'approve' | 'reject') {
    const promptText = stage === 'verify' ? 'Verification notes (include the independent callback or other check)' : stage === 'approve' ? 'Approval reason' : 'Rejection reason';
    const reason = window.prompt(promptText);
    if (!reason) return;
    setError(null); setNotice(null);
    const field = stage === 'verify' ? 'verificationNotes' : 'reason';
    const response = await fetch(`/api/v1/suppliers/${id}/bank-detail-changes/${changeId}/${stage}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ [field]: reason }),
    });
    const result = await response.json() as { error?: { message?: string } };
    if (!response.ok) { setError(result.error?.message ?? `Could not ${stage} the change.`); return; }
    setNotice(`Bank detail change ${stage} step completed.`); await load();
  }

  const pending = changes.some((change) => ['PENDING', 'VERIFICATION_PENDING', 'APPROVAL_PENDING'].includes(change.status));
  return <div className="space-y-5">
    <div><Link href={`/suppliers/${id}`} className="text-sm text-navy-700 hover:underline">← Supplier profile</Link><h1 className="mt-2 text-2xl font-semibold">Supplier bank details</h1><p className="text-sm text-muted-foreground">Changes require independent verification and approval. Previous accounts remain in history.</p></div>
    {error && <Alert tone="danger" title="Bank detail action failed">{error}</Alert>}{notice && <Alert tone="success">{notice}</Alert>}
    {pending && <Alert tone="warning" title="Supplier payments blocked">A bank detail change is pending. Payments remain blocked until it is approved or rejected.</Alert>}
    <Card><CardHeader title="Current and previous bank details" /><CardBody>{loading ? <p className="py-6 text-center text-sm text-muted-foreground">Loading bank details…</p> : bankDetails.length === 0 ? <EmptyState title="No bank details" body="Submit a verified account request below. The first account also follows the full approval workflow." /> : <Table><thead><tr><Th>Bank</Th><Th>Account holder</Th><Th>Account</Th><Th>Currency</Th><Th>Status</Th><Th>Effective</Th></tr></thead><tbody>{bankDetails.map((detail) => <tr key={detail.id}><Td>{detail.bankName}{detail.branchName ? <div className="text-xs text-muted-foreground">{detail.branchName}</div> : null}</Td><Td>{detail.accountHolderName}</Td><Td>•••• {detail.accountNumberLast4}</Td><Td>{detail.currencyCode ?? '—'}</Td><Td><Badge tone={detail.isActive ? 'success' : 'neutral'}>{detail.isActive ? detail.isPrimary ? 'Active primary' : 'Active' : 'Superseded'}</Badge></Td><Td>{formatDate(detail.effectiveFrom)}{detail.effectiveTo ? ` – ${formatDate(detail.effectiveTo)}` : ''}</Td></tr>)}</tbody></Table>}</CardBody></Card>
    <Card><CardHeader title="Request a bank detail change" description="Account numbers are encrypted before storage. Evidence document ID is mandatory." /><CardBody><form onSubmit={(event) => void submitChange(event)} className="grid gap-3 md:grid-cols-2">
      <Input aria-label="Bank name" placeholder="Bank name" value={bankName} onChange={(event) => setBankName(event.target.value)} required />
      <Input aria-label="Account holder" placeholder="Account holder name" value={accountHolderName} onChange={(event) => setAccountHolderName(event.target.value)} required />
      <Input aria-label="Account number" placeholder="Account number" value={accountNumber} onChange={(event) => setAccountNumber(event.target.value)} required autoComplete="off" />
      <Input aria-label="Branch" placeholder="Branch" value={branchName} onChange={(event) => setBranchName(event.target.value)} />
      <Input aria-label="SWIFT code" placeholder="SWIFT code" value={swiftCode} onChange={(event) => setSwiftCode(event.target.value)} />
      <Input aria-label="IBAN" placeholder="IBAN" value={iban} onChange={(event) => setIban(event.target.value)} />
      <Input aria-label="Currency code" placeholder="Currency code (optional)" value={currencyCode} onChange={(event) => setCurrencyCode(event.target.value.toUpperCase().slice(0, 3))} />
      <Input aria-label="Evidence document ID" placeholder="Evidence document ID (CUID)" value={evidenceDocumentId} onChange={(event) => setEvidenceDocumentId(event.target.value)} required />
      <div className="md:col-span-2"><Button type="submit" disabled={saving}>{saving ? 'Submitting…' : 'Submit change request'}</Button></div>
    </form><p className="mt-3 text-xs text-muted-foreground">The document library is scheduled for M12. Until then, enter the ID of an evidence record supplied by your document control process.</p></CardBody></Card>
    <Card><CardHeader title="Change request history" /><CardBody>{changes.length === 0 ? <EmptyState title="No change requests" body="Every request and decision will remain in this history." /> : <div className="space-y-4">{changes.map((change) => <div key={change.id} className="rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><div><Badge tone={change.status === 'APPROVED' ? 'success' : change.status === 'REJECTED' ? 'danger' : 'warning'}>{change.status.replaceAll('_', ' ')}</Badge><span className="ml-2 text-sm text-muted-foreground">Requested {formatDate(change.requestedAt)}</span></div><span className="font-mono text-xs text-muted-foreground">{change.id}</span></div>
      <div className="mt-3 grid gap-3 md:grid-cols-2"><div className="rounded bg-slate-50 p-3 text-sm"><div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Previous</div>{change.previousValues ? <>{change.previousValues.bankName} · {change.previousValues.accountHolderName} · •••• {change.previousValues.accountNumberLast4}</> : 'No previous active account'}</div><div className="rounded bg-slate-50 p-3 text-sm"><div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Requested</div>{change.proposedValues ? <>{change.proposedValues.bankName} · {change.proposedValues.accountHolderName} · •••• {change.proposedValues.accountNumberLast4}</> : 'No proposed account'}</div></div>
      <p className="mt-2 text-xs text-muted-foreground">Requester {change.requestedById} · Verifier {change.verifierId ?? '—'} · Approver {change.approverId ?? '—'} · Evidence {change.evidenceDocumentId}</p>
      {change.verificationNotes && <p className="mt-2 text-sm">Verification: {change.verificationNotes}</p>}{change.decisionReason && <p className="mt-2 text-sm">Decision: {change.decisionReason}</p>}
      <div className="mt-3 flex flex-wrap gap-2">{['PENDING', 'VERIFICATION_PENDING'].includes(change.status) && <Button size="sm" variant="outline" onClick={() => void decide(change.id, 'verify')}>Verify</Button>}{change.status === 'APPROVAL_PENDING' && <><Button size="sm" onClick={() => void decide(change.id, 'approve')}>Approve</Button><Button size="sm" variant="outline" onClick={() => void decide(change.id, 'reject')}>Reject</Button></>}</div>
    </div>)}</div>}</CardBody></Card>
  </div>;
}
