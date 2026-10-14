'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, Label, Select, SelectOption } from '@/components/ui';

const LOCATION_TYPES = [
  { value: 'HEAD_OFFICE', label: 'Head Office' },
  { value: 'OFFICE', label: 'Office' },
  { value: 'LAB', label: 'Lab' },
  { value: 'WAREHOUSE', label: 'Warehouse' },
  { value: 'PROJECT_SITE', label: 'Project Site' },
  { value: 'UNIVERSITY_FACILITY', label: 'University Facility' },
  { value: 'PERMITTED_USE', label: 'Permitted Use' },
  { value: 'REMOTE', label: 'Remote' },
  { value: 'OTHER', label: 'Other' },
];

export default function AddLocationButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState('OFFICE');
  const [isOwned, setIsOwned] = useState(true);

  function reset() {
    setCode('');
    setName('');
    setType('OFFICE');
    setIsOwned(true);
    setError(null);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (!/^[A-Z0-9_-]+$/.test(code.toUpperCase())) {
        throw new Error('Code may only contain letters, numbers, _ and - (no spaces).');
      }
      const res = await fetch('/api/v1/locations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({ code: code.toUpperCase(), name, type, isOwned }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error((j && j.error && j.error.message) || 'Could not create location.');
      }
      setOpen(false);
      reset();
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create location.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Add location
      </Button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl">
            <h2 className="mb-3 text-base font-semibold">Add a new location</h2>
            <form onSubmit={save} className="space-y-3">
              <div>
                <Label htmlFor="locCode">Code (A-Z, 0-9, _, -)</Label>
                <Input id="locCode" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="MBEYA-OFFICE" required maxLength={20} />
              </div>
              <div>
                <Label htmlFor="locName">Name</Label>
                <Input id="locName" value={name} onChange={(e) => setName(e.target.value)} placeholder="Mbeya Office" required minLength={2} maxLength={120} />
              </div>
              <div>
                <Label htmlFor="locType">Type</Label>
                <Select id="locType" value={type} onChange={(e) => setType(e.target.value)}>
                  {LOCATION_TYPES.map((t) => (
                    <SelectOption key={t.value} value={t.value}>{t.label}</SelectOption>
                  ))}
                </Select>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={isOwned} onChange={(e) => setIsOwned(e.target.checked)} />
                Company-owned (not leased)
              </label>
              {error && <div className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="outline" onClick={() => { setOpen(false); reset(); }} disabled={saving}>Cancel</Button>
                <Button type="submit" disabled={saving}>{saving ? 'Saving...' : 'Save location'}</Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
