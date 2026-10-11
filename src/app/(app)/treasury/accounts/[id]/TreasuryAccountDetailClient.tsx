'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Card, CardHeader, CardBody, Badge, Button, Alert } from '@/components/ui';
import { formatDate, shortId } from '@/lib/format';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

type TreasuryAccount = {
  id: string;
  code: string;
  name: string;
  kind: string;
  currencyCode: string;
  ledgerAccountId: string;
  locationId: string | null;
  fundingSourceId: string | null;
  isActive: boolean;
  isRestricted: boolean;
  createdAt: string;
  updatedAt: string;
  _count?: {
    journalLines: number;
    transactions: number;
    paymentSchedules: number;
  };
};

type Actor = {
  roleCodes: string[];
};

function getKindTone(kind: string): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
  switch (kind) {
    case 'CASH':
      return 'success';
    case 'BANK':
      return 'info';
    case 'MOBILE_MONEY':
      return 'warning';
    case 'PAYMENT_GATEWAY':
      return 'info';
    case 'PROJECT_FUND':
      return 'neutral';
    case 'GRANT_FUND':
      return 'warning';
    case 'OTHER':
      return 'neutral';
    default:
      return 'neutral';
  }
}

export default function TreasuryAccountDetailClient({
  actor,
  params,
}: {
  actor: Actor;
  params: Promise<{ id: string }>;
}) {
  const router = useRouter();
  const [account, setAccount] = useState<TreasuryAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const hasEditPermission = useMemo(() => actor.roleCodes.includes('TREASURY_TRANSFERS.EDIT'), [actor.roleCodes]);
  const hasDeletePermission = useMemo(() => actor.roleCodes.includes('TREASURY_TRANSFERS.EDIT'), [actor.roleCodes]);

  const fetchAccount = useCallback(async () => {
    const { id } = await params;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/treasury-accounts/${id}`);
      if (!res.ok) throw new Error('Failed to fetch treasury account');
      const json = await res.json();
      setAccount(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [params]);

  useEffect(() => {
    fetchAccount();
  }, [fetchAccount]);

  const handleDelete = async () => {
    const { id } = await params;
    if (!confirm('Are you sure you want to deactivate this treasury account?')) return;

    setDeleting(true);
    try {
      const res = await fetch(`/api/v1/treasury-accounts/${id}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `delete-${id}-${Date.now()}`,
        },
      });
      if (!res.ok) throw new Error('Failed to delete treasury account');
      router.push('/treasury/accounts');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardBody className="py-12">
          <div className="text-center text-muted-foreground">Loading treasury account…</div>
        </CardBody>
      </Card>
    );
  }

  if (error) {
    return <Alert tone="danger" title="Failed to load treasury account">{error}</Alert>;
  }

  if (!account) {
    return <Alert tone="danger" title="Not found">Treasury account not found</Alert>;
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title={account.name}
          description={account.code}
          actions={
            <div className="flex items-center gap-2">
              {hasEditPermission && (
                <Link href={`/treasury/accounts/${account.id}/edit`}>
                  <Button variant="outline" size="sm">Edit</Button>
                </Link>
              )}
              {hasDeletePermission && (
                <Button variant="danger" size="sm" onClick={handleDelete} disabled={deleting}>
                  {deleting ? 'Deactivating…' : 'Deactivate'}
                </Button>
              )}
            </div>
          }
        />
        <CardBody className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Kind</label>
              <Badge tone={getKindTone(account.kind)} className="text-base">
                {account.kind.replace('_', ' ')}
              </Badge>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Currency</label>
              <div className="font-medium">{account.currencyCode}</div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Status</label>
              <Badge tone={account.isActive ? 'success' : 'neutral'} className="text-base">
                {account.isActive ? 'Active' : 'Inactive'}
              </Badge>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Restricted</label>
              <Badge tone={account.isRestricted ? 'warning' : 'neutral'} className="text-base">
                {account.isRestricted ? 'Yes' : 'No'}
              </Badge>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-4 border-t">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Ledger Account</label>
              <Link href={`/accounting/accounts/${shortId(account.ledgerAccountId)}`} className="text-navy-600 hover:underline font-mono">
                {shortId(account.ledgerAccountId)}
              </Link>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Location</label>
              <div className="font-mono text-sm">{account.locationId ? shortId(account.locationId) : '-'}</div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Funding Source</label>
              <div className="font-mono text-sm">{account.fundingSourceId ? shortId(account.fundingSourceId) : '-'}</div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Created</label>
              <div>{formatDate(account.createdAt)}</div>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-4 border-t">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Journal Lines</label>
              <div className="font-medium">{account._count?.journalLines ?? 0}</div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Transactions</label>
              <div className="font-medium">{account._count?.transactions ?? 0}</div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Payment Schedules</label>
              <div className="font-medium">{account._count?.paymentSchedules ?? 0}</div>
            </div>
          </div>

          <div className="flex gap-4 pt-4 border-t">
            <Link href="/treasury/accounts" className="text-navy-600 hover:underline">
              ← Back to Accounts
            </Link>
            {hasEditPermission && (
              <Link href={`/treasury/accounts/${account.id}/edit`} className="text-navy-600 hover:underline">
                Edit Account
              </Link>
            )}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}