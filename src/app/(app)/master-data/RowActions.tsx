'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  entityType: 'LOCATION' | 'DEPARTMENT' | 'COST_CENTRE' | 'PROJECT' | 'FUNDING_SOURCE' | 'CURRENCY' | 'EXCHANGE_RATE' | 'REASON_CODE' | 'PRODUCT_SERVICE';
  entityId: string;
  entityLabel: string;
  endpoint: string;
  initial: Record<string, unknown>;
  fields: Array<{ name: string; label: string; type?: 'text' | 'number' | 'checkbox'; options?: Array<{ value: string; label: string }> }>;
}

export default function RowActions({ entityType, entityId, entityLabel, endpoint, initial, fields }: Props) {
  const router = useRouter();
  const btnRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>(initial);
  const [reason, setReason] = useState('');

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (btnRef.current && btnRef.current.contains(e.target as Node)) return;
      const menu = document.getElementById('row-actions-menu');
      if (menu && menu.contains(e.target as Node)) return;
      setMenuOpen(false);
    }
    function onScroll() { setMenuOpen(false); }
    if (menuOpen) {
      document.addEventListener('mousedown', onDoc);
      window.addEventListener('scroll', onScroll, true);
    }
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [menuOpen]);

  function openMenu(e: React.MouseEvent) {
    e.stopPropagation();
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setMenuPos({ top: r.bottom + 4, left: r.right - 160 });
    }
    setMenuOpen((v) => !v);
  }

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
        throw new Error((j && j.error && j.error.message) || 'Could not save.');
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
        throw new Error((j && j.error && j.error.message) || 'Could not submit.');
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
      <button
        ref={btnRef}
        type="button"
        aria-label="More actions"
        onClick={openMenu}
        className="text-muted-foreground hover:bg-muted/40 hover:text-foreground rounded p-1"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" />
        </svg>
      </button>

      {menuOpen && menuPos && (
        <div
          id="row-actions-menu"
          style={{ position: 'fixed', top: menuPos.top, left: menuPos.left, zIndex: 1000 }}
          className="border-border-subtle w-40 rounded-md border bg-white py-1 shadow-lg"
        >
          <button type="button" onClick={() => { setMenuOpen(false); setEditOpen(true); }}
            className="hover:bg-muted/40 block w-full px-3 py-1.5 text-left text-sm">
            Edit
          </button>
          <button type="button" onClick={() => { setMenuOpen(false); setTrashOpen(true); }}
            className="hover:bg-muted/40 block w-full px-3 py-1.5 text-left text-sm text-red-600">
            Move to trash
          </button>
        </div>
      )}

      {editOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !busy && setEditOpen(false)}>
          <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-3 text-base font-semibold">Edit {entityLabel}</h2>
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
          </div>
        </div>
      )}

      {trashOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !busy && setTrashOpen(false)}>
          <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-2 text-base font-semibold">Move to trash</h2>
            <p className="text-muted-foreground mb-3 text-sm">
              Moving <strong>{entityLabel}</strong> to trash requires CEO approval. Once approved, the
              record is restorable for 90 days.
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
                  className="rounded bg-red-600 px-3 py-1.5 text-sm text-white">{busy ? 'Submitting…' : 'Send for CEO approval'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
