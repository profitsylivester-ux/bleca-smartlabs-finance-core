'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function RestoreButton({ changeId, disabled }: { changeId: string; disabled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function restore() {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/v1/master-data/changes/${changeId}/restore`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error((j && j.error && j.error.message) || `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (c) {
      setError(c instanceof Error ? c.message : 'Failed');
    } finally { setBusy(false); }
  }

  return (
    <div className="flex items-center gap-2">
      <button type="button" onClick={restore} disabled={busy || disabled}
        className="border-navy-300 text-navy-700 rounded border px-3 py-1 text-xs disabled:opacity-50">
        {busy ? 'Restoring…' : 'Restore'}
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
