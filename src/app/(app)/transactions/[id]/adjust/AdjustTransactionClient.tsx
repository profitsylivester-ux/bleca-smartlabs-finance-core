'use client';

import { useState, useEffect, useMemo } from 'react';
import { Card, CardHeader, CardBody, Button, Input, Label, Alert, Select, SelectOption, Table, Th, Td } from '@/components/ui';
import { useRouter } from 'next/navigation';
import { formatAmount, formatDate, shortId } from '@/lib/format';
import { z } from 'zod';

const adjustSchema = z.object({
  reasonCodeId: z.string().min(1, 'Reason code is required'),
  evidenceDocumentId: z.string().optional(),
  description: z.string().min(1, 'Adjustment description is required'),
  amount: z.string().refine(val => parseFloat(val) >= 0.01, 'Amount must be greater than 0'),
});

type FormData = z.infer<typeof adjustSchema>;
type FormErrors = Partial<Record<keyof FormData, string>>;

type ReasonCode = { id: string; code: string; name: string; description: string | null; category: string; isActive: boolean };
type Transaction = {
  id: string;
  status: string | null;
  reference: string | null;
  amount: number;
  currencyCode: string;
  description: string | null;
  date: string;
  account: { id: string; code: string; name: string } | null;
};

export default function AdjustTransactionClient({ transactionId }: { transactionId: string }) {
  const router = useRouter();
  const [transaction, setTransaction] = useState<Transaction | null>(null);
  const [formData, setFormData] = useState<FormData>({
    reasonCodeId: '',
    evidenceDocumentId: '',
    description: '',
    amount: '',
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [reasonCodes, setReasonCodes] = useState<ReasonCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const adjustmentReasonCodes = useMemo(() =>
    reasonCodes.filter(rc => rc.category === 'ADJUSTMENT' && rc.isActive),
    [reasonCodes]
  );

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {
        const [txRes, reasonsRes] = await Promise.all([
          fetch(`/api/v1/transactions/${transactionId}`),
          fetch('/api/v1/reason-codes'),
        ]);
        if (!txRes.ok) throw new Error('Failed to fetch transaction');
        if (!reasonsRes.ok) throw new Error('Failed to fetch reason codes');
        const txJson = await txRes.json();
        const reasonsJson = await reasonsRes.json();
        setTransaction(txJson.data);
        setReasonCodes(reasonsJson.data || []);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Failed to load data');
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [transactionId]);

  const handleChange = (field: keyof FormData, value: string | undefined) => {
    setFormData((prev) => ({ ...prev, [field]: value ?? '' }));
    if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: undefined }));
    }
  };

  const validateField = (field: keyof FormData, value: string): string | undefined => {
    try {
      const fieldSchema = adjustSchema.shape[field];
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

    const selectedReason = adjustmentReasonCodes.find((rc) => rc.id === formData.reasonCodeId);
    if (!selectedReason) {
      setSubmitError('Please select a valid reason code');
      return;
    }

    if (!confirm('Create an adjusting transaction? This will create a new transaction linked to the original.')) return;

    setSubmitting(true);
    try {
      const res = await fetch(`/api/v1/transactions/${transactionId}/adjust`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          reason: `${selectedReason.code}: ${formData.description}`,
          evidenceDocumentId: formData.evidenceDocumentId || undefined,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error?.message || 'Failed to adjust transaction');
      }

      const json = await res.json();
      router.push(`/transactions/${json.data.id}`);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to adjust transaction');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardBody className="py-12">
          <div className="text-center text-muted-foreground">Loading…</div>
        </CardBody>
      </Card>
    );
  }

  if (loadError || !transaction) {
    return <Alert tone="danger" title="Failed to load transaction">{loadError ?? 'Transaction not found'}</Alert>;
  }

  if (transaction.status !== 'POSTED' && transaction.status !== 'LOCKED') {
    return (
      <Alert tone="warning" title="Adjustment Not Allowed">
        This transaction is in <strong>{transaction.status}</strong> state. Adjustments are only allowed for POSTED or LOCKED transactions.
        <Button variant="ghost" size="sm" className="mt-2" onClick={() => router.back()}>
          Back to Transaction
        </Button>
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Adjust Transaction"
          description={`Original: ${transaction.reference ?? shortId(transaction.id)} • ${formatAmount(transaction.amount, transaction.currencyCode)}`}
          actions={
            <Button variant="ghost" size="sm" onClick={() => router.back()}>
              Cancel
            </Button>
          }
        />
        <CardBody>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm mb-6 p-4 bg-surface-muted rounded">
            <div><span className="text-muted-foreground">Reference</span><br />{transaction.reference ?? '-'}</div>
            <div><span className="text-muted-foreground">Date</span><br />{formatDate(transaction.date)}</div>
            <div><span className="text-muted-foreground">Account</span><br />{transaction.account?.code ?? '-'}</div>
            <div><span className="text-muted-foreground">Amount</span><br />{formatAmount(transaction.amount, transaction.currencyCode)}</div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            {submitError && <Alert tone="danger" title="Error">{submitError}</Alert>}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="reasonCodeId">Reason Code *</Label>
                <Select
                  id="reasonCodeId"
                  value={formData.reasonCodeId}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => handleChange('reasonCodeId', e.target.value)}
                  onBlur={() => handleBlur('reasonCodeId')}
                  className={errors.reasonCodeId ? 'border-negative' : ''}
                >
                  <SelectOption value="">Select a reason code</SelectOption>
                  {adjustmentReasonCodes.map((rc) => (
                    <SelectOption key={rc.id} value={rc.id}>{rc.code} - {rc.name}</SelectOption>
                  ))}
                </Select>
                {errors.reasonCodeId && <p className="text-negative text-xs mt-1">{errors.reasonCodeId}</p>}
              </div>

              <div>
                <Label htmlFor="evidenceDocumentId">Evidence Document ID</Label>
                <Input
                  id="evidenceDocumentId"
                  type="text"
                  placeholder="Document ID (optional)"
                  value={formData.evidenceDocumentId}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleChange('evidenceDocumentId', e.target.value)}
                />
              </div>
            </div>

            <div>
              <Label htmlFor="description">Adjustment Description *</Label>
              <Input
                id="description"
                type="text"
                placeholder="Describe the adjustment reason"
                value={formData.description}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleChange('description', e.target.value)}
                onBlur={() => handleBlur('description')}
                className={errors.description ? 'border-negative' : ''}
              />
              {errors.description && <p className="text-negative text-xs mt-1">{errors.description}</p>}
            </div>

            <div>
              <Label htmlFor="amount">Adjustment Amount *</Label>
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
              <p className="text-xs text-muted-foreground mt-1">The adjustment will create a new transaction with this amount.</p>
            </div>

            <div className="flex justify-end gap-3 pt-4 border-t">
              <Button type="button" variant="ghost" onClick={() => router.back()}>
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? 'Creating Adjustment…' : 'Create Adjustment'}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      {adjustmentReasonCodes.length > 0 && (
        <Card>
          <CardHeader title="Available Adjustment Reason Codes" />
          <CardBody>
            <Table>
              <thead>
                <tr>
                  <Th>Code</Th>
                  <Th>Name</Th>
                  <Th>Category</Th>
                  <Th>Description</Th>
                </tr>
              </thead>
              <tbody>
                {adjustmentReasonCodes.map((rc) => (
                  <tr key={rc.id}>
                    <Td>{rc.code}</Td>
                    <Td>{rc.name}</Td>
                    <Td>{rc.category}</Td>
                    <Td>{rc.description ?? '-'}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </CardBody>
        </Card>
      )}
    </div>
  );
}