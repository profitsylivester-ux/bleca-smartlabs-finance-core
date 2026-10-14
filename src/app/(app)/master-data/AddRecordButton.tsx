'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, Label, Select, SelectOption } from '@/components/ui';

export interface AddField {
  name: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'select' | 'checkbox';
  required?: boolean;
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
  defaultValue?: string | boolean;
  maxLength?: number;
  minLength?: number;
  uppercase?: boolean;
  hint?: string;
}

export interface AddConfig {
  buttonLabel: string;
  modalTitle: string;
  endpoint: string;
  fields: AddField[];
}

interface Props {
  config: AddConfig;
  lookup?: Record<string, Array<{ value: string; label: string }>>;
}

function initialValues(config: AddConfig): Record<string, string | boolean> {
  const v: Record<string, string | boolean> = {};
  for (const f of config.fields) {
    if (f.type === 'checkbox') v[f.name] = Boolean(f.defaultValue ?? false);
    else if (f.type === 'select') v[f.name] = String(f.defaultValue ?? (f.options?.[0]?.value ?? ''));
    else v[f.name] = String(f.defaultValue ?? '');
  }
  return v;
}

export default function AddRecordButton({ config, lookup }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string | boolean>>(() => initialValues(config));

  function reset() {
    setValues(initialValues(config));
    setError(null);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {};
      for (const f of config.fields) {
        let val = values[f.name];
        if (typeof val === 'string') {
          if (!val) continue;
          if (f.uppercase) val = val.toUpperCase();
        }
        body[f.name] = val;
      }
      const res = await fetch(config.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error((j && j.error && j.error.message) || 'Could not save.');
      }
      setOpen(false);
      reset();
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>{config.buttonLabel}</Button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl">
            <h2 className="mb-3 text-base font-semibold">{config.modalTitle}</h2>
            <form onSubmit={save} className="space-y-3">
              {config.fields.map((f) => {
                const opts = ((lookup && lookup[f.name]) ? lookup[f.name] : f.options) ?? [];
                return (
                  <div key={f.name}>
                    <Label htmlFor={'add-' + f.name}>
                      {f.label}{f.required ? ' *' : ''}
                    </Label>
                    {f.type === 'select' ? (
                      <Select
                        id={'add-' + f.name}
                        value={String(values[f.name] ?? '')}
                        onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                      >
                        {opts.map((o) => (
                          <SelectOption key={o.value} value={o.value}>{o.label}</SelectOption>
                        ))}
                      </Select>
                    ) : f.type === 'checkbox' ? (
                      <div className="pt-1">
                        <input
                          id={'add-' + f.name}
                          type="checkbox"
                          checked={Boolean(values[f.name])}
                          onChange={(e) => setValues({ ...values, [f.name]: e.target.checked })}
                        />
                      </div>
                    ) : (
                      <Input
                        id={'add-' + f.name}
                        type={f.type}
                        value={String(values[f.name] ?? '')}
                        onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                        required={f.required}
                        placeholder={f.placeholder}
                        maxLength={f.maxLength}
                        minLength={f.minLength}
                      />
                    )}
                    {f.hint && <p className="text-muted-foreground mt-1 text-xs">{f.hint}</p>}
                  </div>
                );
              })}
              {error && <div className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="outline" onClick={() => { setOpen(false); reset(); }} disabled={saving}>Cancel</Button>
                <Button type="submit" disabled={saving}>{saving ? 'Saving...' : 'Save'}</Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

export const LOCATIONS_CONFIG: AddConfig = {
  buttonLabel: 'Add location',
  modalTitle: 'Add a new location',
  endpoint: '/api/v1/locations',
  fields: [
    { name: 'code', label: 'Code (A-Z, 0-9, _, -)', type: 'text', required: true, maxLength: 20, uppercase: true, placeholder: 'MBEYA-OFFICE' },
    { name: 'name', label: 'Name', type: 'text', required: true, minLength: 2, maxLength: 120, placeholder: 'Mbeya Office' },
    { name: 'type', label: 'Type', type: 'select', required: true, defaultValue: 'OFFICE', options: [
      { value: 'HEAD_OFFICE', label: 'Head Office' },
      { value: 'OFFICE', label: 'Office' },
      { value: 'LAB', label: 'Lab' },
      { value: 'WAREHOUSE', label: 'Warehouse' },
      { value: 'PROJECT_SITE', label: 'Project Site' },
      { value: 'UNIVERSITY_FACILITY', label: 'University Facility' },
      { value: 'PERMITTED_USE', label: 'Permitted Use' },
      { value: 'REMOTE', label: 'Remote' },
      { value: 'OTHER', label: 'Other' },
    ] },
    { name: 'isOwned', label: 'Company-owned (not leased)', type: 'checkbox', defaultValue: true },
  ],
};

export const DEPARTMENTS_CONFIG: AddConfig = {
  buttonLabel: 'Add department',
  modalTitle: 'Add a new department',
  endpoint: '/api/v1/departments',
  fields: [
    { name: 'code', label: 'Code (A-Z, 0-9, _, -)', type: 'text', required: true, maxLength: 20, uppercase: true, placeholder: 'OPS' },
    { name: 'name', label: 'Name', type: 'text', required: true, minLength: 2, maxLength: 120, placeholder: 'Operations' },
  ],
};

export const COST_CENTRES_CONFIG: AddConfig = {
  buttonLabel: 'Add cost centre',
  modalTitle: 'Add a new cost centre',
  endpoint: '/api/v1/cost-centres',
  fields: [
    { name: 'code', label: 'Code', type: 'text', required: true, maxLength: 20, uppercase: true, placeholder: 'OPS-NORTH' },
    { name: 'name', label: 'Name', type: 'text', required: true, minLength: 2, maxLength: 120, placeholder: 'Northern Region' },
    { name: 'departmentId', label: 'Department', type: 'select', options: [] },
    { name: 'description', label: 'Description (optional)', type: 'text', maxLength: 500 },
  ],
};

export const PROJECTS_CONFIG: AddConfig = {
  buttonLabel: 'Add project',
  modalTitle: 'Add a new project',
  endpoint: '/api/v1/projects',
  fields: [
    { name: 'code', label: 'Code', type: 'text', required: true, maxLength: 20, uppercase: true, placeholder: 'SOLAR-01' },
    { name: 'name', label: 'Name', type: 'text', required: true, minLength: 2, maxLength: 120, placeholder: 'Solar Panel Phase 1' },
    { name: 'status', label: 'Status', type: 'select', required: true, defaultValue: 'DRAFT', options: [
      { value: 'DRAFT', label: 'Draft' },
      { value: 'ACTIVE', label: 'Active' },
      { value: 'ON_HOLD', label: 'On Hold' },
      { value: 'COMPLETED', label: 'Completed' },
      { value: 'CANCELLED', label: 'Cancelled' },
      { value: 'ARCHIVED', label: 'Archived' },
    ] },
    { name: 'startDate', label: 'Start date (optional)', type: 'date' },
    { name: 'endDate', label: 'End date (optional)', type: 'date' },
    { name: 'description', label: 'Description (optional)', type: 'text', maxLength: 500 },
  ],
};

export const FUNDING_SOURCES_CONFIG: AddConfig = {
  buttonLabel: 'Add funding source',
  modalTitle: 'Add a new funding source',
  endpoint: '/api/v1/funding-sources',
  fields: [
    { name: 'code', label: 'Code', type: 'text', required: true, maxLength: 20, uppercase: true, placeholder: 'XYZ-GRANT' },
    { name: 'name', label: 'Name', type: 'text', required: true, minLength: 2, maxLength: 120, placeholder: 'XYZ Foundation Grant' },
    { name: 'type', label: 'Type', type: 'select', required: true, options: [
      { value: 'UNRESTRICTED', label: 'Unrestricted' },
      { value: 'RESTRICTED_GRANT', label: 'Restricted grant' },
      { value: 'DESIGNATED', label: 'Designated' },
      { value: 'ENDOWMENT', label: 'Endowment' },
      { value: 'CONTRACT_REVENUE', label: 'Contract revenue' },
      { value: 'INTERNAL_ALLOCATION', label: 'Internal allocation' },
      { value: 'OTHER', label: 'Other' },
    ] },
    { name: 'isRestricted', label: 'Restricted to specific use', type: 'checkbox' },
    { name: 'description', label: 'Description (optional)', type: 'text', maxLength: 500 },
  ],
};

export const CURRENCIES_CONFIG: AddConfig = {
  buttonLabel: 'Add currency',
  modalTitle: 'Add a new currency',
  endpoint: '/api/v1/currencies',
  fields: [
    { name: 'code', label: 'ISO code (3 letters)', type: 'text', required: true, maxLength: 3, minLength: 3, uppercase: true, placeholder: 'USD' },
    { name: 'name', label: 'Name', type: 'text', required: true, minLength: 2, maxLength: 120, placeholder: 'US Dollar' },
    { name: 'symbol', label: 'Symbol (optional)', type: 'text', maxLength: 10, placeholder: '$' },
    { name: 'type', label: 'Type', type: 'select', required: true, defaultValue: 'FIAT', options: [
      { value: 'FIAT', label: 'Fiat' },
      { value: 'CRYPTO', label: 'Cryptocurrency' },
      { value: 'COMPOSITE', label: 'Composite' },
    ] },
    { name: 'isBase', label: 'Is base currency (only one per org)', type: 'checkbox' },
  ],
};

export const EXCHANGE_RATES_CONFIG: AddConfig = {
  buttonLabel: 'Add exchange rate',
  modalTitle: 'Add an exchange rate',
  endpoint: '/api/v1/exchange-rates',
  fields: [
    { name: 'baseCurrencyId', label: 'From currency', type: 'select', required: true, options: [] },
    { name: 'quoteCurrencyId', label: 'To currency', type: 'select', required: true, options: [] },
    { name: 'rateDate', label: 'Rate date', type: 'date', required: true },
    { name: 'rate', label: 'Rate (e.g. 2500.50)', type: 'text', required: true, placeholder: '2500.50' },
  ],
};

export const REASON_CODES_CONFIG: AddConfig = {
  buttonLabel: 'Add reason code',
  modalTitle: 'Add a new reason code',
  endpoint: '/api/v1/reason-codes',
  fields: [
    { name: 'code', label: 'Code', type: 'text', required: true, maxLength: 50, minLength: 2, uppercase: true, placeholder: 'DUPLICATE-ENTRY' },
    { name: 'name', label: 'Name', type: 'text', required: true, minLength: 2, maxLength: 120, placeholder: 'Duplicate Entry' },
    { name: 'category', label: 'Category', type: 'select', required: true, defaultValue: 'OTHER', options: [
      { value: 'REVENUE', label: 'Revenue' },
      { value: 'EXPENSE', label: 'Expense' },
      { value: 'TRANSFER', label: 'Transfer' },
      { value: 'ADJUSTMENT', label: 'Adjustment' },
      { value: 'OTHER', label: 'Other' },
    ] },
    { name: 'description', label: 'Description (optional)', type: 'text', maxLength: 500 },
  ],
};

export const PRODUCTS_SERVICES_CONFIG: AddConfig = {
  buttonLabel: 'Add product/service',
  modalTitle: 'Add a new product or service',
  endpoint: '/api/v1/products-services',
  fields: [
    { name: 'code', label: 'Code', type: 'text', required: true, maxLength: 50, minLength: 2, uppercase: true, placeholder: 'SOLAR-300W' },
    { name: 'name', label: 'Name', type: 'text', required: true, minLength: 2, maxLength: 120, placeholder: 'Solar Panel 300W' },
    { name: 'type', label: 'Type', type: 'select', required: true, options: [
      { value: 'PRODUCT', label: 'Product' },
      { value: 'SERVICE', label: 'Service' },
    ] },
    { name: 'unit', label: 'Unit', type: 'text', required: true, maxLength: 20, placeholder: 'pcs' },
    { name: 'unitPrice', label: 'Unit price (optional)', type: 'text', placeholder: '150000' },
    { name: 'currencyCode', label: 'Currency code (3 letters)', type: 'text', required: true, maxLength: 3, minLength: 3, uppercase: true, defaultValue: 'TZS' },
    { name: 'description', label: 'Description (optional)', type: 'text', maxLength: 500 },
  ],
};

