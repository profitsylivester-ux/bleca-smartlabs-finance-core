'use client';

import { useState, useEffect, useMemo } from 'react';
import { Card, CardHeader, CardBody, Button, Input, Label, Alert, Select, SelectOption, Table, Th, Td } from '@/components/ui';
import { useRouter } from 'next/navigation';
import { formatAmount, formatDate, shortId } from '@/lib/format';
import { z } from 'zod';

const reverseSchema = z.object({
  reasonCodeId: z.string().min(1, 'Reason code is required'),
  evidenceDocumentId: z.string().optional(),
  description: z.string().min(1, 'Reversal description is required'),
  originalTransactionId: z.string().optional(),
});

type FormData = z.infer<typeof reverseSchema>;
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
  journalEntry: { id: string; number: string | null } | null;
};

export default function ReverseTransactionClient({ transactionId }: { transactionId: string }) {
  const router = useRouter();
  const [transaction, setTransaction] = useState<Transaction | null>(null);
  const [formData, setFormData] = useState<FormData>({
    reasonCodeId: '',
    evidenceDocumentId: '',
    description: '',
    originalTransactionId: '',
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [reasonCodes, setReasonCodes] = useState<ReasonCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reversalReasonCodes = useMemo(() =>
    reasonCodes.filter(rc => rc.category === 'REVERSAL' && rc.isActive),
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
      const fieldSchema = reverseSchema.shape[field];
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

    const selectedReason = reversalReasonCodes.find((rc) => rc.id === formData.reasonCodeId);
    if (!selectedReason) {
      setSubmitError('Please select a valid reason code');
      return;
    }

    if (!confirm('Reverse this transaction? This will create a reversing transaction linked to the original. The original transaction will remain visible.')) return;

    setSubmitting(true);
    try {
      const res = await fetch(`/api/v1/transactions/${transactionId}/reverse`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          reason: `${selectedReason.code}: ${formData.description}`,
          evidenceDocumentId: formData.evidenceDocumentId || undefined,
          originalTransactionId: formData.originalTransactionId || transactionId,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error?.message || 'Failed to reverse transaction');
      }

      const json = await res.json();
      router.push(`/transactions/${json.data.id}`);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to reverse transaction');
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
      <Alert tone="warning" title="Reversal Not Allowed">
        This transaction is in <strong>{transaction.status}</strong> state. Reversals are only allowed for POSTED or LOCKED transactions.
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
          title="Reverse Transaction"
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

          {transaction.journalEntry && (
            <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded">
              <p className="text-sm text-amber-800">
                <strong>Note:</strong> This transaction has an associated journal entry ({transaction.journalEntry.number ?? transaction.journalEntry.id}).
                Reversal will create a reversing journal entry that offsets the original.
              </p>
            </div>
          )}

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
                  {reversalReasonCodes.map((rc) => (
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
              <Label htmlFor="description">Reversal Description *</Label>
              <Input
                id="description"
                type="text"
                placeholder="Describe the reversal reason"
                value={formData.description}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleChange('description', e.target.value)}
                onBlur={() => handleBlur('description')}
                className={errors.description ? 'border-negative' : ''}
              />
              {errors.description && <p className="text-negative text-xs mt-1">{errors.description}</p>}
            </div>

            <div>
              <Label htmlFor="originalTransactionId">Original Transaction ID</Label>
              <Input
                id="originalTransactionId"
                type="text"
                value={formData.originalTransactionId || transactionId}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleChange('originalTransactionId', e.target.value)}
                readOnly
              />
              <p className="text-xs text-muted-foreground mt-1">Automatically linked to the original transaction.</p>
            </div>

            <div className="flex justify-end gap-3 pt-4 border-t">
              <Button type="button" variant="ghost" onClick={() => router.back()}>
                Cancel
              </Button>
              <Button type="submit" variant="danger" disabled={submitting}>
                {submitting ? 'Reversing…' : 'Reverse Transaction'}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      {reversalReasonCodes.length > 0 && (
        <Card>
          <CardHeader title="Available Reversal Reason Codes" />
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
                {reversalReasonCodes.map((rc) => (
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