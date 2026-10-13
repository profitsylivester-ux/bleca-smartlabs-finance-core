'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import {
  Card,
  CardHeader,
  CardBody,
  Badge,
  Button,
  Table,
  Th,
  Td,
  EmptyState,
  Alert,
  Input,
  Select,
  SelectOption,
} from '@/components/ui';
import { formatDate, formatAmount } from '@/lib/format';

type ChecklistItem = {
  itemKey: string;
  label: string;
  isBlocking: boolean;
  isAutomated: boolean;
  status: string;
  computedValue?: string | null;
  confirmedById?: string | null;
  confirmedAt?: string | null;
  waivedById?: string | null;
  waivedAt?: string | null;
  waiverReason?: string | null;
  waiverApproverId?: string | null;
  waiverApprovedAt?: string | null;
};

type Period = {
  id: string;
  code: string;
  name: string;
  status: string;
  type: string;
  startDate: Date | string;
  endDate: Date | string;
};

type CloseSession = {
  id: string;
  periodId: string;
  status: string;
  checklistItems: ChecklistItem[];
  startedAt?: string | null;
  submittedAt?: string | null;
  signedOffAt?: string | null;
  approvalRequestId?: string | null;
} | null;

type Actor = {
  roleCodes: string[];
};

type Permissions = {
  canStartClose: boolean;
  canEditClose: boolean;
  canSubmitClose: boolean;
  canSignOff: boolean;
  canRunYearEnd: boolean;
};

const STATUS_TONES: Record<string, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
  NOT_STARTED: 'neutral',
  IN_PROGRESS: 'info',
  PASSED: 'success',
  FAILED: 'danger',
  WAIVED: 'warning',
  NOT_APPLICABLE: 'neutral',
};

const STATUS_LABELS: Record<string, string> = {
  NOT_STARTED: 'Not Started',
  IN_PROGRESS: 'In Progress',
  PASSED: 'Passed',
  FAILED: 'Failed',
  WAIVED: 'Waived',
  NOT_APPLICABLE: 'N/A',
};

const CLOSE_STATUS_TONES: Record<string, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
  IN_PROGRESS: 'info',
  SUBMITTED: 'warning',
  SIGNED_OFF: 'success',
  REOPENED: 'danger',
};

export default function CloseClient({
  actor,
  period,
  close,
  permissions,
}: {
  actor: Actor;
  period: Period;
  close: CloseSession;
  permissions: Permissions;
}) {
  const [items, setItems] = useState<ChecklistItem[]>(close?.checklistItems ?? []);
  const [closeStatus, setCloseStatus] = useState(close?.status ?? 'NOT_STARTED');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<ChecklistItem | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<'check' | 'waive'>('check');
  const [waiveReason, setWaiveReason] = useState('');
  const [waiveApproverId, setWaiveApproverId] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  const loadClose = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/periods/${period.id}/close`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error?.message ?? 'Failed to load close state.');
        return;
      }
      const body = await res.json();
      if (body.data.close) {
        setItems(body.data.close.checklistItems);
        setCloseStatus(body.data.close.status);
      }
    } catch {
      setError('Failed to load close state.');
    } finally {
      setLoading(false);
    }
  }, [period.id, refreshKey]);

  useEffect(() => {
    void loadClose();
  }, [loadClose]);

  const handleAction = async (action: 'start' | 'check' | 'waive' | 'submit' | 'signoff' | 'yearend') => {
    setLoading(true);
    setError(null);
    try {
      let url = '';
      let method = 'POST';
      let body: Record<string, unknown> = {};

      switch (action) {
        case 'start':
          url = `/api/v1/periods/${period.id}/close/start`;
          break;
        case 'check':
          if (!selectedItem) return;
          url = `/api/v1/periods/${period.id}/close/items/${selectedItem.itemKey}/check`;
          break;
        case 'waive':
          if (!selectedItem) return;
          url = `/api/v1/periods/${period.id}/close/items/${selectedItem.itemKey}/waive`;
          body = { reason: waiveReason, waiverApproverId: waiveApproverId };
          break;
        case 'submit':
          url = `/api/v1/periods/${period.id}/close/submit`;
          break;
        case 'signoff':
          url = `/api/v1/periods/${period.id}/close/sign-off`;
          body = { approvalRequestId: close?.approvalRequestId, decision: 'APPROVED' };
          break;
        case 'yearend':
          url = `/api/v1/periods/${period.id}/year-end`;
          break;
      }

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message ?? 'Action failed');
      }

      setModalOpen(false);
      setSelectedItem(null);
      setWaiveReason('');
      setWaiveApproverId('');
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setLoading(false);
    }
  };

  const openCheckModal = (item: ChecklistItem) => {
    setSelectedItem(item);
    setModalMode('check');
    setModalOpen(true);
  };

  const openWaiveModal = (item: ChecklistItem) => {
    setSelectedItem(item);
    setModalMode('waive');
    setModalOpen(true);
  };

  const canStartClose = permissions.canStartClose && !close && period.status === 'OPEN';
  const canEditItems = permissions.canEditClose && close && closeStatus === 'IN_PROGRESS';
  const canSubmit = permissions.canSubmitClose && close && closeStatus === 'IN_PROGRESS';
  const canSignOff = permissions.canSignOff && close && closeStatus === 'SUBMITTED';
  const canRunYearEnd = permissions.canRunYearEnd && period.type === 'ANNUAL' && ['CLOSED', 'LOCKED'].includes(period.status);

  const blockingFailed = items.filter((i) => i.isBlocking && i.status === 'FAILED').length;
  const blockingWaived = items.filter((i) => i.isBlocking && i.status === 'WAIVED').length;
  const manualNotStarted = items.filter((i) => !i.isAutomated && i.status === 'NOT_STARTED').length;

  const renderModal = () => {
    if (!modalOpen || !selectedItem) return null;

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
        <div className="w-full max-w-md bg-white rounded-lg shadow-xl p-6">
          <h3 className="text-lg font-semibold mb-4">
            {modalMode === 'check' ? `Confirm: ${selectedItem.label}` : `Waive: ${selectedItem.label}`}
          </h3>
          {modalMode === 'check' ? (
            <div className="space-y-4">
              <p>Mark this manual checklist item as PASSED?</p>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setModalOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={() => handleAction('check')} disabled={loading}>
                  Confirm
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-amber-600">
                Waiving a blocking item requires an approver. The item will be marked as WAIVED pending approval.
              </p>
              <div className="space-y-2">
                <label className="block text-xs font-medium text-muted-foreground">Waiver Reason (required)</label>
                <textarea
                  className="border-border-strong text-foreground h-24 w-full rounded-md border bg-white px-3 text-sm placeholder:text-muted-foreground"
                  placeholder="Explain why this item is being waived..."
                  value={waiveReason}
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setWaiveReason(e.target.value)}
                  required
                  minLength={10}
                  maxLength={1000}
                />
              </div>
              <div className="space-y-2">
                <label className="block text-xs font-medium text-muted-foreground">Waiver Approver User ID</label>
                <Input
                  placeholder="Enter approver user ID (CUID)"
                  value={waiveApproverId}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setWaiveApproverId(e.target.value)}
                  required
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setModalOpen(false)}>
                  Cancel
                </Button>
                <Button variant="danger" onClick={() => handleAction('waive')} disabled={loading || !waiveReason || !waiveApproverId}>
                  Waive Item
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title={`Period Close: ${period.code} — ${period.name}`}
          description={`Type: ${period.type} | ${formatDate(period.startDate)} to ${formatDate(period.endDate)}`}
          actions={
            <div className="flex gap-2">
              {canStartClose && (
                <Button onClick={() => handleAction('start')} disabled={loading}>
                  Start Close
                </Button>
              )}
              {canSubmit && (
                <Button onClick={() => handleAction('submit')} disabled={loading || blockingFailed > 0 || manualNotStarted > 0}>
                  Submit for Sign-off
                </Button>
              )}
              {canSignOff && (
                <Button onClick={() => handleAction('signoff')} disabled={loading} variant="default">
                  CEO Sign-off
                </Button>
              )}
              {canRunYearEnd && (
                <Button onClick={() => handleAction('yearend')} disabled={loading} variant="default">
                  Run Year-End
                </Button>
              )}
            </div>
          }
        />
        <CardBody>
          <div className="mb-4 flex flex-wrap gap-2">
            <Badge tone={CLOSE_STATUS_TONES[closeStatus] ?? 'neutral'} className="text-sm">
              {closeStatus.replace(/_/g, ' ')}
            </Badge>
            {close && (
              <>
                <Badge tone="neutral" className="text-sm">
                  Started: {close.startedAt ? formatDate(close.startedAt) : '—'}
                </Badge>
                {close.submittedAt && (
                  <Badge tone="neutral" className="text-sm">
                    Submitted: {formatDate(close.submittedAt)}
                  </Badge>
                )}
                {close.signedOffAt && (
                  <Badge tone="success" className="text-sm">
                    Signed Off: {formatDate(close.signedOffAt)}
                  </Badge>
                )}
              </>
            )}
          </div>

          {error && <Alert tone="danger">{error}</Alert>}

          {items.length === 0 && !close ? (
            <EmptyState
              title="No close session started"
              body="Click 'Start Close' to begin the financial close process for this period."
            />
          ) : items.length === 0 ? (
            <EmptyState title="No checklist items" body="Checklist items will appear after starting the close." />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th className="w-[30%]">Checklist Item</Th>
                  <Th className="w-[10%]">Type</Th>
                  <Th className="w-[10%]">Blocking</Th>
                  <Th className="w-[20%]">Status</Th>
                  <Th className="w-[30%]">Details / Actions</Th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.itemKey}>
                    <Td className="font-medium">{item.label}</Td>
                    <Td>
                      <Badge tone={item.isAutomated ? 'info' : 'neutral'}>
                        {item.isAutomated ? 'Automated' : 'Manual'}
                      </Badge>
                    </Td>
                    <Td>
                      <Badge tone={item.isBlocking ? 'danger' : 'neutral'}>
                        {item.isBlocking ? 'Yes' : 'No'}
                      </Badge>
                    </Td>
                    <Td>
                      <Badge tone={STATUS_TONES[item.status] ?? 'neutral'}>
                        {STATUS_LABELS[item.status] ?? item.status}
                      </Badge>
                    </Td>
                    <Td className="flex items-center gap-2">
                      {item.computedValue && (
                        <span className="text-xs text-muted-foreground font-mono">
                          {(() => {
                            try {
                              const parsed = JSON.parse(item.computedValue!);
                              return `${parsed.value}: ${parsed.detail}`;
                            } catch {
                              return item.computedValue!;
                            }
                          })()}
                        </span>
                      )}
                      {canEditItems && !item.isAutomated && item.status !== 'PASSED' && item.status !== 'WAIVED' && (
                        <Button size="sm" onClick={() => openCheckModal(item)}>
                          Confirm
                        </Button>
                      )}
                      {canEditItems && !item.isAutomated && item.status !== 'PASSED' && item.status !== 'WAIVED' && (
                        <Button size="sm" variant="outline" onClick={() => openWaiveModal(item)}>
                          Waive
                        </Button>
                      )}
                      {item.status === 'PASSED' && item.confirmedAt && (
                        <span className="text-xs text-muted-foreground">
                          Confirmed {formatDate(item.confirmedAt)}
                        </span>
                      )}
                      {item.status === 'WAIVED' && item.waivedAt && (
                        <span className="text-xs text-muted-foreground">
                          Waived {formatDate(item.waivedAt)}
                          {item.waiverReason && <span className="ml-1">({item.waiverReason})</span>}
                        </span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}

          {close && closeStatus === 'IN_PROGRESS' && (
            <div className="mt-4 p-4 bg-muted rounded-lg text-sm">
              <strong>Submission readiness:</strong>{' '}
              {blockingFailed > 0 ? (
                <span className="text-red-600">{blockingFailed} blocking item(s) failing — cannot submit</span>
              ) : manualNotStarted > 0 ? (
                <span className="text-amber-600">{manualNotStarted} manual item(s) not confirmed — cannot submit</span>
              ) : (
                <span className="text-green-600">All blocking items passed/waived, manual items confirmed — ready to submit</span>
              )}
            </div>
          )}
        </CardBody>
      </Card>

      {renderModal()}
    </div>
  );
}