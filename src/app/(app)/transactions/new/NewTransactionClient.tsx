'use client';

import { useState, useEffect, useMemo } from 'react';
import { Card, CardHeader, CardBody, Button, Input, Label, Alert, Select, SelectOption } from '@/components/ui';
import { useRouter } from 'next/navigation';
import { z } from 'zod';

const createSchema = z.object({
  date: z.string().min(1, 'Date is required'),
  description: z.string().optional(),
  reference: z.string().optional(),
  accountId: z.string().optional(),
  amount: z.string().refine(val => parseFloat(val) >= 0.01, 'Amount must be greater than 0'),
  currencyCode: z.string().length(3, 'Currency code must be 3 characters'),
  paymentMethod: z.enum(['CASH', 'BANK_TRANSFER', 'CHEQUE', 'MOBILE_MONEY', 'PAYMENT_GATEWAY', 'CARD', 'OTHER']),
  projectId: z.string().optional(),
  departmentId: z.string().optional(),
  costCentreId: z.string().optional(),
  fundingSourceId: z.string().optional(),
  supportingDocumentId: z.string().optional(),
});

type FormData = {
  date: string;
  description: string;
  reference: string;
  accountId: string;
  amount: string;
  currencyCode: string;
  paymentMethod: 'CASH' | 'BANK_TRANSFER' | 'CHEQUE' | 'MOBILE_MONEY' | 'PAYMENT_GATEWAY' | 'CARD' | 'OTHER';
  projectId: string;
  departmentId: string;
  costCentreId: string;
  fundingSourceId: string;
  supportingDocumentId: string;
};
type FormErrors = Partial<Record<keyof FormData, string>>;

type LookupOption = { id: string; code: string; name: string; status?: string; isActive?: boolean; isPostable?: boolean; parentId?: string; children?: LookupOption[] };

function flattenAccounts(accounts: LookupOption[]): LookupOption[] {
  const result: LookupOption[] = [];
  function traverse(items: LookupOption[]) {
    for (const item of items) {
      if (item.isPostable && item.status === 'ACTIVE') {
        result.push({ id: item.id, code: item.code, name: item.name });
      }
      if (item.children && item.children.length > 0) {
        traverse(item.children);
      }
    }
  }
  traverse(accounts);
  return result;
}

export default function NewTransactionClient() {
  const router = useRouter();
  const initialFormData: FormData = {
    date: (new Date().toISOString().split('T')[0] ?? '') as string,
    description: '',
    reference: '',
    accountId: '',
    amount: '',
    currencyCode: 'TZS',
    paymentMethod: 'CASH',
    projectId: '',
    departmentId: '',
    costCentreId: '',
    fundingSourceId: '',
    supportingDocumentId: '',
  };
  const [formData, setFormData] = useState<FormData>(initialFormData);
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<LookupOption[]>([]);
  const [projects, setProjects] = useState<LookupOption[]>([]);
  const [departments, setDepartments] = useState<LookupOption[]>([]);
  const [costCentres, setCostCentres] = useState<LookupOption[]>([]);
  const [fundingSources, setFundingSources] = useState<LookupOption[]>([]);

  const activeProjects = useMemo(() => projects.filter(p => p.status === 'ACTIVE' && p.isActive !== false), [projects]);
  const activeDepartments = useMemo(() => departments.filter(d => d.isActive !== false), [departments]);
  const activeCostCentres = useMemo(() => costCentres.filter(cc => cc.isActive !== false), [costCentres]);
  const activeFundingSources = useMemo(() => fundingSources.filter(fs => fs.isActive !== false), [fundingSources]);
  const postableAccounts = useMemo(() => flattenAccounts(accounts), [accounts]);

  useEffect(() => {
    const fetchLookups = async () => {
      try {
        const [accountsRes, projectsRes, departmentsRes, costCentresRes, fundingSourcesRes] = await Promise.all([
          fetch('/api/v1/accounts'),
          fetch('/api/v1/projects'),
          fetch('/api/v1/departments'),
          fetch('/api/v1/cost-centres'),
          fetch('/api/v1/funding-sources'),
        ]);
        if (accountsRes.ok) {
          const json = await accountsRes.json();
          setAccounts(json.data || []);
        }
        if (projectsRes.ok) {
          const json = await projectsRes.json();
          setProjects(json.data || []);
        }
        if (departmentsRes.ok) {
          const json = await departmentsRes.json();
          setDepartments(json.data || []);
        }
        if (costCentresRes.ok) {
          const json = await costCentresRes.json();
          setCostCentres(json.data || []);
        }
        if (fundingSourcesRes.ok) {
          const json = await fundingSourcesRes.json();
          setFundingSources(json.data || []);
        }
      } catch {
        // Ignore lookup errors
      }
    };
    fetchLookups();
  }, []);

  const handleChange = (field: keyof FormData, value: string | undefined) => {
    setFormData((prev) => ({ ...prev, [field]: value ?? '' }));
    if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: undefined }));
    }
  };

  const validateField = (field: keyof FormData, value: string): string | undefined => {
    try {
      const fieldSchema = createSchema.shape[field];
      if (fieldSchema) {
        fieldSchema.parse(value);
      }
      return undefined;
    } catch (err) {
      if (err instanceof z.ZodError) {
        return err.issues[0]?.message || 'Invalid value';
      }
      return 'Invalid value';
    }
  };

  const handleBlur = (field: keyof FormData) => {
    const error = validateField(field, formData[field] ?? '');
    if (error) {
      setErrors((prev) => ({ ...prev, [field]: error }));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);

    const newErrors: FormErrors = {};
    (Object.keys(formData) as Array<keyof FormData>).forEach((field) => {
      const value = formData[field] ?? '';
      const error = validateField(field, value);
      if (error) newErrors[field] = error;
    });

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/v1/transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: new Date(formData.date).toISOString(),
          description: formData.description || undefined,
          reference: formData.reference || undefined,
          accountId: formData.accountId || undefined,
          amount: parseFloat(formData.amount),
          currencyCode: formData.currencyCode,
          paymentMethod: formData.paymentMethod,
          projectId: formData.projectId || undefined,
          departmentId: formData.departmentId || undefined,
          costCentreId: formData.costCentreId || undefined,
          fundingSourceId: formData.fundingSourceId || undefined,
          supportingDocumentId: formData.supportingDocumentId || undefined,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error?.message || 'Failed to create transaction');
      }

      const json = await res.json();
      router.push(`/transactions/${json.data.id}`);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to create transaction');
    } finally {
      setSubmitting(false);
    }
  };

  const paymentMethods = [
    { value: 'CASH', label: 'Cash' },
    { value: 'BANK_TRANSFER', label: 'Bank Transfer' },
    { value: 'CHEQUE', label: 'Cheque' },
    { value: 'MOBILE_MONEY', label: 'Mobile Money' },
    { value: 'PAYMENT_GATEWAY', label: 'Payment Gateway' },
    { value: 'CARD', label: 'Card' },
    { value: 'OTHER', label: 'Other' },
  ];

  return (
    <Card>
      <CardHeader title="Transaction Details" description="All fields marked with * are required per PDF §8." />
      <CardBody>
        <form onSubmit={handleSubmit} className="space-y-6">
          {submitError && <Alert tone="danger" title="Error">{submitError}</Alert>}

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <Label htmlFor="date">Date *</Label>
              <Input
                id="date"
                type="date"
                value={formData.date}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleChange('date', e.target.value)}
                onBlur={() => handleBlur('date')}
                className={errors.date ? 'border-negative' : ''}
              />
              {errors.date && <p className="text-negative text-xs mt-1">{errors.date}</p>}
            </div>

            <div>
              <Label htmlFor="reference">Reference</Label>
              <Input
                id="reference"
                type="text"
                placeholder="Auto-generated if empty"
                value={formData.reference}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleChange('reference', e.target.value)}
              />
            </div>

            <div>
              <Label htmlFor="currencyCode">Currency *</Label>
              <Input
                id="currencyCode"
                type="text"
                maxLength={3}
                value={formData.currencyCode}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleChange('currencyCode', e.target.value.toUpperCase())}
                onBlur={() => handleBlur('currencyCode')}
                className={errors.currencyCode ? 'border-negative' : ''}
              />
              {errors.currencyCode && <p className="text-negative text-xs mt-1">{errors.currencyCode}</p>}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="amount">Amount *</Label>
              <Input
                id="amount"
                type="number"
                step="0.01"
                min="0.01"
                placeholder="0.00"
                value={formData.amount}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleChange('amount', e.target.value)}
                onBlur={() => handleBlur('amount')}
                className={errors.amount ? 'border-negative' : ''}
              />
              {errors.amount && <p className="text-negative text-xs mt-1">{errors.amount}</p>}
            </div>

            <div>
              <Label htmlFor="paymentMethod">Payment Method *</Label>
              <Select
                id="paymentMethod"
                value={formData.paymentMethod}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => handleChange('paymentMethod', e.target.value)}
                onBlur={() => handleBlur('paymentMethod')}
                className={errors.paymentMethod ? 'border-negative' : ''}
              >
                {paymentMethods.map((pm) => (
                  <SelectOption key={pm.value} value={pm.value}>{pm.label}</SelectOption>
                ))}
              </Select>
              {errors.paymentMethod && <p className="text-negative text-xs mt-1">{errors.paymentMethod}</p>}
            </div>
          </div>

          <div>
            <Label htmlFor="description">Description *</Label>
            <Input
              id="description"
              type="text"
              placeholder="Transaction description"
              value={formData.description}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleChange('description', e.target.value)}
              onBlur={() => handleBlur('description')}
              className={errors.description ? 'border-negative' : ''}
            />
            {errors.description && <p className="text-negative text-xs mt-1">{errors.description}</p>}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <Label htmlFor="accountId">Account *</Label>
              <Select
                id="accountId"
                value={formData.accountId}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => handleChange('accountId', e.target.value)}
                onBlur={() => handleBlur('accountId')}
                className={errors.accountId ? 'border-negative' : ''}
              >
                <SelectOption value="">Select an account</SelectOption>
                {postableAccounts.map((acc) => (
                  <SelectOption key={acc.id} value={acc.id}>{acc.code} - {acc.name}</SelectOption>
                ))}
              </Select>
              {errors.accountId && <p className="text-negative text-xs mt-1">{errors.accountId}</p>}
            </div>

            <div>
              <Label htmlFor="projectId">Project</Label>
              <Select
                id="projectId"
                value={formData.projectId}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => handleChange('projectId', e.target.value)}
              >
                <SelectOption value="">Select a project (optional)</SelectOption>
                {activeProjects.map((p) => (
                  <SelectOption key={p.id} value={p.id}>{p.code} - {p.name}</SelectOption>
                ))}
              </Select>
            </div>

            <div>
              <Label htmlFor="departmentId">Department</Label>
              <Select
                id="departmentId"
                value={formData.departmentId}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => handleChange('departmentId', e.target.value)}
              >
                <SelectOption value="">Select a department (optional)</SelectOption>
                {activeDepartments.map((d) => (
                  <SelectOption key={d.id} value={d.id}>{d.code} - {d.name}</SelectOption>
                ))}
              </Select>
            </div>

            <div>
              <Label htmlFor="costCentreId">Cost Centre</Label>
              <Select
                id="costCentreId"
                value={formData.costCentreId}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => handleChange('costCentreId', e.target.value)}
              >
                <SelectOption value="">Select a cost centre (optional)</SelectOption>
                {activeCostCentres.map((cc) => (
                  <SelectOption key={cc.id} value={cc.id}>{cc.code} - {cc.name}</SelectOption>
                ))}
              </Select>
            </div>

            <div>
              <Label htmlFor="fundingSourceId">Funding Source</Label>
              <Select
                id="fundingSourceId"
                value={formData.fundingSourceId}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => handleChange('fundingSourceId', e.target.value)}
              >
                <SelectOption value="">Select a funding source (optional)</SelectOption>
                {activeFundingSources.map((fs) => (
                  <SelectOption key={fs.id} value={fs.id}>{fs.code} - {fs.name}</SelectOption>
                ))}
              </Select>
            </div>

            <div>
              <Label htmlFor="supportingDocumentId">Supporting Document</Label>
              <Input
                id="supportingDocumentId"
                type="text"
                placeholder="Document ID (optional)"
                value={formData.supportingDocumentId}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleChange('supportingDocumentId', e.target.value)}
              />
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t">
            <Button type="button" variant="ghost" onClick={() => router.back()}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Creating…' : 'Create Transaction'}
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}