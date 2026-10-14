'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createPortal } from 'react-dom';

interface Props {
  entityType: 'LOCATION' | 'DEPARTMENT' | 'COST_CENTRE' | 'PROJECT' | 'FUNDING_SOURCE' | 'CURRENCY' | 'EXCHANGE_RATE' | 'REASON_CODE' | 'PRODUCT_SERVICE';
  entityId: string;
  entityLabel: string;
  endpoint: string;
  initial: Record<string, unknown>;
  fields: Array<{ name: string; label: string; type?: 'text' | 'number' | 'checkbox'; options?: Array<{ value: string; label: string }> }>;
}

function Modal({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); return () => setMounted(false); }, []);
  if (!mounted) return null;
  return createPortal(
    <div className="fixed inset-0 flex items-center justify-center bg-black/50 p-4" style={{ zIndex: 9999 }} onClick={onClose}>
      <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export default function RowActions({ entityType, entityId, entityLabel, endpoint, initial, fields }: Props) {
  const router = useRouter();
  const [editOpen, setEditOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>(initial);
  const [reason, setReason] = useState('');
  const [isCeo, setIsCeo] = useState(false);

  useEffect(() => {
    fetch('/api/v1/me').then((r) => r.json()).then((d) => setIsCeo(Boolean(d.isCeo))).catch(() => undefined);
  }, []);

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${endpoint}/${entityId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify(values),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error((j && j.error && j.error.message) || `Could not save (HTTP ${res.status}).`);
      }
      setEditOpen(false);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save.');
    } finally { setBusy(false); }
  }

  async function requestTrash(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/v1/master-data/changes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({
          entityType,
          entityId,
          proposedChanges: { deleted: true, deletedAt: new Date().toISOString() },
          reason,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error((j && j.error && j.error.message) || `Could not submit (HTTP ${res.status}).`);
      }
      const created = await res.json().catch(() => ({}));
      const changeId = created && (created.id || (created.data && created.data.id));
      if (isCeo && changeId) {
        await fetch(`/api/v1/master-data/changes/${changeId}/approve`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
          body: JSON.stringify({ action: 'APPROVE' }),
        });
      }
      setTrashOpen(false);
      setReason('');
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not submit.');
    } finally { setBusy(false); }
  }

  return (
    <>
      <div className="flex justify-end gap-1">
        <button type="button" onClick={() => setEditOpen(true)} title="Edit"
          className="text-navy-700 hover:bg-navy-50 rounded p-1">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
          </svg>
        </button>
        <button type="button" onClick={() => setTrashOpen(true)} title={isCeo ? 'Delete' : 'Move to trash'}
          className="text-red-600 hover:bg-red-50 rounded p-1">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
          </svg>
        </button>
      </div>

      {editOpen && (
        <Modal onClose={() => !busy && setEditOpen(false)}>
          <h2 className="mb-1 text-base font-semibold">Edit {entityLabel}</h2>
          <p className="text-muted-foreground mb-3 text-xs">The Finance Officer will be notified of this edit.</p>
          <form onSubmit={saveEdit} className="space-y-3">
            {fields.map((f) => (
              <div key={f.name}>
                <label className="block text-sm font-medium">{f.label}</label>
                {f.type === 'checkbox' ? (
                  <input type="checkbox" checked={Boolean(values[f.name])} onChange={(e) => setValues({ ...values, [f.name]: e.target.checked })} />
                ) : f.options ? (
                  <select value={String(values[f.name] ?? '')} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                    className="border-border-strong mt-1 block w-full rounded-md border bg-white px-3 py-2 text-sm">
                    {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                ) : (
                  <input type={f.type || 'text'} value={String(values[f.name] ?? '')} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                    className="border-border-strong mt-1 block w-full rounded-md border px-3 py-2 text-sm" />
                )}
              </div>
            ))}
            {error && <div className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setEditOpen(false)} disabled={busy}
                className="border-border rounded border px-3 py-1.5 text-sm">Cancel</button>
              <button type="submit" disabled={busy}
                className="bg-navy-800 rounded px-3 py-1.5 text-sm text-white">{busy ? 'Saving…' : 'Save'}</button>
            </div>
          </form>
        </Modal>
      )}

      {trashOpen && (
        <Modal onClose={() => !busy && setTrashOpen(false)}>
          <h2 className="mb-2 text-base font-semibold">{isCeo ? 'Delete' : 'Move to trash'}</h2>
          <p className="text-muted-foreground mb-3 text-sm">
            {isCeo ? (
              <>You are the CEO, so <strong>{entityLabel}</strong> will be deleted immediately. It stays restorable for 90 days.</>
            ) : (
              <>Moving <strong>{entityLabel}</strong> to trash requires CEO approval. Once approved, the record is restorable for 90 days.</>
            )}
          </p>
          <form onSubmit={requestTrash} className="space-y-3">
            <label className="block text-sm font-medium">Reason (min 10 characters)</label>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} required minLength={10} maxLength={500}
              className="border-border-strong block w-full rounded-md border px-3 py-2 text-sm" rows={3} />
            {error && <div className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setTrashOpen(false)} disabled={busy}
                className="border-border rounded border px-3 py-1.5 text-sm">Cancel</button>
              <button type="submit" disabled={busy}
                className="rounded bg-red-600 px-3 py-1.5 text-sm text-white">{busy ? 'Deleting…' : (isCeo ? 'Delete' : 'Send for CEO approval')}</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
