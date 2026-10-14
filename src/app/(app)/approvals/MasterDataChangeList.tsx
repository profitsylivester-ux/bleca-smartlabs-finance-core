'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

interface Change {
  id: string;
  entityType: string;
  entityId: string | null;
  reason: string;
  createdAt: string;
}

export default function MasterDataChangeList({ changes }: { changes: Change[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isCeo, setIsCeo] = useState<boolean | null>(null);

  useEffect(() => {
    fetch('/api/v1/me')
      .then((r) => r.json())
      .then((d) => setIsCeo(Boolean(d.isCeo)))
      .catch(() => setIsCeo(false));
  }, []);

  async function decide(id: string, action: 'APPROVE' | 'REJECT') {
    setBusy(id); setError(null);
    try {
      const res = await fetch(`/api/v1/master-data/changes/${id}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({ action, ...(action === 'REJECT' ? { rejectionReason: 'Rejected by CEO' } : {}) }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error((j && j.error && j.error.message) || `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (c) {
      setError(c instanceof Error ? c.message : 'Failed');
    } finally { setBusy(null); }
  }

  if (isCeo === null) return null;
  if (!isCeo) return null;
  if (changes.length === 0) return <div className="text-muted-foreground px-5 py-6 text-sm">No pending business setup requests.</div>;

  return (
    <>
      {error && <div className="mx-5 my-2 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      <ul className="divide-border-subtle divide-y">
        {changes.map((c) => (
          <li key={c.id} className="px-5 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium mono text-sm">{c.entityType}</span>
                {c.entityId && <span className="text-muted-foreground mono text-xs">#{c.entityId.slice(0, 8)}</span>}
              </div>
              <span className="text-xs text-muted-foreground">{new Date(c.createdAt).toLocaleString()}</span>
            </div>
            <p className="text-muted-foreground mt-1 text-sm">{c.reason}</p>
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={() => decide(c.id, 'APPROVE')} disabled={busy === c.id}
                className="rounded bg-green-600 px-3 py-1 text-xs text-white disabled:opacity-50">
                {busy === c.id ? 'Working…' : 'Approve'}
              </button>
              <button type="button" onClick={() => decide(c.id, 'REJECT')} disabled={busy === c.id}
                className="rounded border border-red-300 px-3 py-1 text-xs text-red-700 disabled:opacity-50">
                Reject
              </button>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
