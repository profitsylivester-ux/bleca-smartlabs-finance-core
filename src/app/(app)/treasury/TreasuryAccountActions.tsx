'use client';

import { useState } from 'react';
import { Card, CardHeader, CardBody, Button, Input, Alert, Badge } from '@/components/ui';
import { formatAmount } from '@/lib/format';
import { useRouter } from 'next/navigation';

type TreasuryAccount = {
  id: string;
  code: string;
  name: string;
  kind: string;
  currencyCode: string;
  isActive: boolean;
  isRestricted: boolean;
};

interface TreasuryAccountActionsProps {
  accounts: TreasuryAccount[];
  kind: string;
  actor: { roleCodes: string[] };
}

function getKindLabel(kind: string): string {
  return kind.replace('_', ' ');
}

export default function TreasuryAccountActions({ accounts, kind, actor }: TreasuryAccountActionsProps) {
  const router = useRouter();
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null);
  const [actionType, setActionType] = useState<'deposit' | 'withdrawal' | null>(null);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [reference, setReference] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const hasCreatePermission = actor.roleCodes.includes('TREASURY_TRANSFERS.CREATE');

  const selectedAccount = accounts.find(a => a.id === activeAccountId);

  const handleAction = async (type: 'deposit' | 'withdrawal') => {
    if (!selectedAccount) return;
    
    setActionType(type);
    setError(null);
    setSuccess(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAccount || !actionType) return;

    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      setError('Please enter a valid amount');
      return;
    }

    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const endpoint = actionType === 'deposit' ? 'deposit' : 'withdrawal';
      const res = await fetch(`/api/v1/treasury-accounts/${selectedAccount.id}/${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `${endpoint}-${selectedAccount.id}-${Date.now()}`,
        },
        body: JSON.stringify({
          amount: numAmount,
          currencyCode: selectedAccount.currencyCode,
          description,
          reference,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error?.message || 'Failed to process transaction');
      }

      setSuccess(`${actionType === 'deposit' ? 'Deposit' : 'Withdrawal'} of ${formatAmount(numAmount, selectedAccount.currencyCode)} processed successfully`);
      setAmount('');
      setDescription('');
      setReference('');
      setActionType(null);
      setActiveAccountId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = () => {
    setActionType(null);
    setActiveAccountId(null);
    setAmount('');
    setDescription('');
    setReference('');
    setError(null);
    setSuccess(null);
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title={`${getKindLabel(kind)} Accounts`}
          description={accounts.length === 0 ? 'No accounts found' : `${accounts.length} account${accounts.length > 1 ? 's' : ''} found`}
        />
        <CardBody>
          {accounts.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No ${getKindLabel(kind).toLowerCase()} accounts configured yet.
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {accounts.map((account) => (
                <Card key={account.id} className={`transition-all ${activeAccountId === account.id ? 'ring-2 ring-navy-500' : ''}`} onClick={() => hasCreatePermission && setActiveAccountId(activeAccountId === account.id ? null : account.id)}>
                  <CardHeader
                    title={
                      <div>
                        <h3 className="font-semibold">{account.name}</h3>
                        <p className="text-sm text-muted-foreground font-mono">{account.code}</p>
                      </div>
                    }
                    actions={
                      <div className="flex items-center gap-2">
                        <Badge tone={account.isActive ? 'success' : 'neutral'}>
                          {account.isActive ? 'Active' : 'Inactive'}
                        </Badge>
                        {account.isRestricted && (
                          <Badge tone="warning">Restricted</Badge>
                        )}
                      </div>
                    }
                  />
                  <CardBody className="pt-0">
                    <div className="flex items-baseline gap-2 text-lg font-semibold">
                      {formatAmount(0, account.currencyCode).replace(/[\d,.]/g, '')}
                      <span className="text-muted-foreground">Balance from ledger</span>
                    </div>
                    {activeAccountId === account.id && hasCreatePermission && (
                      <div className="mt-3 pt-3 border-t space-y-3">
                        <div className="flex gap-2">
                          <Button
                            variant={actionType === 'deposit' ? 'default' : 'outline'}
                            size="sm"
                            onClick={() => handleAction('deposit')}
                            disabled={!hasCreatePermission}
                          >
                            Deposit
                          </Button>
                          <Button
                            variant={actionType === 'withdrawal' ? 'default' : 'outline'}
                            size="sm"
                            onClick={() => handleAction('withdrawal')}
                            disabled={!hasCreatePermission}
                          >
                            Withdrawal
                          </Button>
                        </div>
                      </div>
                    )}
                  </CardBody>
                </Card>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      {actionType && selectedAccount && hasCreatePermission && (
        <Card className="border-navy-500">
          <CardHeader title={`${actionType === 'deposit' ? 'Deposit' : 'Withdrawal'} to ${selectedAccount.name}`} />
          <CardBody>
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && <Alert tone="danger" title="Error">{error}</Alert>}
              {success && <Alert tone="success" title="Success">{success}</Alert>}
              
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Amount</label>
                <Input
                  type="number"
                  step="0.01"
                  min="0.01"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  required
                  disabled={loading}
                />
              </div>
              
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Description</label>
                <Input
                  type="text"
                  placeholder="Optional description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  disabled={loading}
                />
              </div>
              
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Reference</label>
                <Input
                  type="text"
                  placeholder="Optional reference"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  disabled={loading}
                />
              </div>

              <div className="flex gap-2 pt-2">
                <Button type="submit" disabled={loading} size="lg">
                  {loading ? 'Processing...' : `Process ${actionType.charAt(0).toUpperCase() + actionType.slice(1)}`}
                </Button>
                <Button type="button" variant="outline" onClick={handleCancel} size="lg" disabled={loading}>
                  Cancel
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>
      )}
    </div>
  );
}