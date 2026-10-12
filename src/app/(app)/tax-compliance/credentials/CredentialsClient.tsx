'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardBody, CardHeader, EmptyState, Input, Select, SelectOption, Table, Td, Th } from '@/components/ui';

type CredentialRow = {
  id: string; type: string; title: string; status: string;
  expiryDate: string | null; renewalReminderDays: number;
  responsible: { fullName: string };
};

const TYPES = ['REGISTRATION', 'TIN_CERTIFICATE', 'LICENCE', 'PERMIT', 'CERTIFICATION', 'MEMBERSHIP', 'DOMAIN', 'INSURANCE', 'SOFTWARE_SUBSCRIPTION', 'OTHER'];

export default function CredentialsClient({ users }: { users: Array<{ id: string; fullName: string }> }) {
  const [rows, setRows] = useState<CredentialRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState('LICENCE');
  const [owner, setOwner] = useState('');
  const [expiry, setExpiry] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const response = await fetch('/api/v1/credentials');
      const result = await response.json() as { data?: CredentialRow[]; error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message ?? 'Could not load credentials.');
      setRows(result.data ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load credentials.');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (!owner && users.length > 0) setOwner(users[0]!.id); }, [owner, users]);

  async function createCredential(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError(null); setNotice(null);
    try {
      const response = await fetch('/api/v1/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({
          type: kind, title: title.trim(), responsibleUserId: owner,
          expiryDate: expiry || null,
        }),
      });
      const result = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message ?? 'Could not create credential.');
      setTitle(''); setExpiry('');
      setNotice('Credential recorded. Renewal reminders are derived from the expiry date.');
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create credential.'); }
    finally { setSaving(false); }
  }

  return <div className="space-y-5">
    {error && <Alert tone="danger" title="Credential request failed">{error}</Alert>}
    {notice && <Alert tone="success">{notice}</Alert>}
    <Card><CardHeader title="Credentials" description="Registrations, licences, permits and renewals with expiry reminders." /><CardBody>
      <form onSubmit={(event) => void createCredential(event)} className="mb-5 grid gap-3 rounded-lg border border-border p-4 md:grid-cols-[2fr_1fr_1fr_1fr_auto]">
        <Input aria-label="Title" placeholder="Credential title" value={title} onChange={(event) => setTitle(event.target.value)} required />
        <Select aria-label="Type" value={kind} onChange={(event) => setKind(event.target.value)}>{TYPES.map((value) => <SelectOption key={value} value={value}>{value}</SelectOption>)}</Select>
        <Select aria-label="Responsible owner" value={owner} onChange={(event) => setOwner(event.target.value)}>{users.map((user) => <SelectOption key={user.id} value={user.id}>{user.fullName}</SelectOption>)}</Select>
        <Input aria-label="Expiry date" type="date" value={expiry} onChange={(event) => setExpiry(event.target.value)} />
        <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'New credential'}</Button>
      </form>
      {loading ? <p className="py-8 text-center text-sm text-muted-foreground">Loading credentials…</p> : rows.length === 0 ? <EmptyState title="No credentials tracked" body="Record the first licence, permit or registration." /> : <Table><thead><tr><Th>Credential</Th><Th>Type</Th><Th>Owner</Th><Th>Expiry</Th><Th>Status</Th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}>
        <Td className="font-medium">{row.title}</Td>
        <Td>{row.type}</Td>
        <Td>{row.responsible.fullName}</Td>
        <Td>{row.expiryDate?.slice(0, 10) ?? '—'}</Td>
        <Td><Badge tone={row.status === 'EXPIRED' ? 'danger' : row.status === 'EXPIRING_SOON' ? 'warning' : row.status === 'ACTIVE' ? 'success' : 'neutral'}>{row.status}</Badge></Td>
      </tr>)}</tbody></Table>}
    </CardBody></Card>
  </div>;
}
