'use client';

import { useState, useEffect, useCallback } from 'react';
import { AlertTriangle, Check, X, Flag, Loader2, Filter, ChevronLeft, ChevronRight, Eye } from 'lucide-react';
import { Button } from '@/components/ui';
import { formatDateTime, formatRelative, formatInteger } from '@/lib/format';
import { Badge } from '@/components/ui';

interface AnomalyFlag {
  id: string;
  anomalyType: string;
  severity: string;
  status: string;
  entityType: string;
  entityId: string;
  entityLabel: string | null;
  description: string;
  evidence: Record<string, unknown> | null;
  dedupeKey: string | null;
  acknowledgedAt: string | null;
  acknowledgedById: string | null;
  dismissedAt: string | null;
  dismissedById: string | null;
  dismissReason: string | null;
  confirmedAt: string | null;
  confirmedById: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AnomalyListResponse {
  data: AnomalyFlag[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

const STATUS_OPTIONS = ['OPEN', 'ACKNOWLEDGED', 'DISMISSED', 'CONFIRMED'] as const;
const SEVERITY_OPTIONS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

export function AnomaliesClient() {
  const [anomalies, setAnomalies] = useState<AnomalyFlag[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [severityFilter, setSeverityFilter] = useState<string>('');
  const [typeFilter, setTypeFilter] = useState<string>('');
  const [entityFilter, setEntityFilter] = useState<string>('');
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchAnomalies = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (statusFilter) params.set('status', statusFilter);
      if (severityFilter) params.set('severity', severityFilter);
      if (typeFilter) params.set('anomalyType', typeFilter);
      if (entityFilter) params.set('entityType', entityFilter);

      const res = await fetch(`/api/v1/anomalies?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to fetch anomalies');
      const data: AnomalyListResponse = await res.json();
      setAnomalies(data.data);
      setTotal(data.total);
      setTotalPages(data.totalPages);
    } catch (err) {
      console.error('Failed to load anomalies:', err);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, statusFilter, severityFilter, typeFilter, entityFilter]);

  useEffect(() => {
    fetchAnomalies();
  }, [fetchAnomalies]);

  const handleAction = async (id: string, action: 'acknowledge' | 'dismiss' | 'confirm') => {
    setActionLoading(id);
    try {
      let body: Record<string, string> = {};
      if (action === 'acknowledge') {
        const reason = prompt('Reason for acknowledging this anomaly (min 5 characters):');
        if (!reason || reason.trim().length < 5) {
          alert('Acknowledgment reason must be at least 5 characters.');
          return;
        }
        body = { reason: reason.trim() };
      } else if (action === 'dismiss') {
        const reason = prompt('Reason for dismissing this anomaly (min 5 characters):');
        if (!reason || reason.trim().length < 5) {
          alert('Dismissal reason must be at least 5 characters.');
          return;
        }
        body = { reason: reason.trim() };
      } else if (action === 'confirm') {
        const reason = prompt('Reason for confirming this anomaly (optional):');
        if (reason) body = { reason: reason.trim() };
      }

      const res = await fetch(`/api/v1/anomalies/${id}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error?.message ?? 'Action failed');
      }

      await fetchAnomalies();
    } catch (err) {
      console.error(`Failed to ${action} anomaly:`, err);
      alert(`Failed to ${action}: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setActionLoading(null);
    }
  };

  const handleScan = async () => {
    if (!confirm('Run a full anomaly scan now? This may take a few seconds.')) return;
    setLoading(true);
    try {
      const res = await fetch('/api/v1/anomalies/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      });
      if (!res.ok) throw new Error('Scan failed');
      const data = await res.json();
      alert(`Scan complete: ${data.data.flagsCreated} new flags from ${data.data.rulesRun.length} rules`);
      await fetchAnomalies();
    } catch (err) {
      console.error('Failed to run scan:', err);
      alert('Scan failed');
    } finally {
      setLoading(false);
    }
  };

  const getSeverityBadge = (severity: string) => {
    switch (severity) {
      case 'CRITICAL':
        return <Badge tone="danger">{severity}</Badge>;
      case 'HIGH':
        return <Badge tone="warning">{severity}</Badge>;
      case 'MEDIUM':
        return <Badge tone="info">{severity}</Badge>;
      default:
        return <Badge tone="neutral">{severity}</Badge>;
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'OPEN':
        return <Badge tone="warning">{status}</Badge>;
      case 'ACKNOWLEDGED':
        return <Badge tone="info">{status}</Badge>;
      case 'CONFIRMED':
        return <Badge tone="danger">{status}</Badge>;
      default:
        return <Badge tone="success">{status}</Badge>;
    }
  };

  const types = Array.from(new Set(anomalies.map((a) => a.anomalyType))).sort();
  const entities = Array.from(new Set(anomalies.map((a) => a.entityType))).sort();

  if (loading) {
    return (
      <div className="border-border-subtle rounded-lg border bg-white p-8 text-center text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2" />
        Loading anomalies…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-border-subtle border bg-white rounded-lg p-4">
        <div className="flex items-center gap-3 flex-wrap">
          <Button onClick={handleScan} variant="outline" size="sm">
            <Flag className="h-3.5 w-3.5 mr-1" />
            Run scan
          </Button>
          <div className="flex items-center gap-1 border-border-subtle border rounded-md p-1">
            {STATUS_OPTIONS.map((s) => (
              <Button
                key={s}
                variant={statusFilter === s ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setStatusFilter(statusFilter === s ? '' : s)}
              >
                {s}
              </Button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={severityFilter}
            onChange={(e) => setSeverityFilter(e.target.value)}
            className="border-border-subtle border rounded-md px-3 py-1.5 text-sm bg-white"
          >
            <option value="">All severities</option>
            {SEVERITY_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="border-border-subtle border rounded-md px-3 py-1.5 text-sm bg-white"
          >
            <option value="">All types</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <select
            value={entityFilter}
            onChange={(e) => setEntityFilter(e.target.value)}
            className="border-border-subtle border rounded-md px-3 py-1.5 text-sm bg-white"
          >
            <option value="">All entities</option>
            {entities.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Table */}
      {anomalies.length === 0 ? (
        <div className="border-border-subtle rounded-lg border bg-white p-8 text-center text-muted-foreground">
          No anomalies found.
        </div>
      ) : (
        <>
          <div className="border-border-subtle rounded-lg border bg-white overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-border-subtle border-b bg-white/50 text-left text-xs font-medium text-muted-foreground">
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Severity</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Entity</th>
                  <th className="px-4 py-3">Description</th>
                  <th className="px-4 py-3">Created</th>
                  <th className="px-4 py-3 w-40">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-border-subtle divide-y">
                {anomalies.map((a) => (
                  <tr key={a.id} className="text-sm">
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs">{a.anomalyType}</span>
                    </td>
                    <td className="px-4 py-3">{getSeverityBadge(a.severity)}</td>
                    <td className="px-4 py-3">{getStatusBadge(a.status)}</td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs">{a.entityType}</span>
                      <span className="text-muted-foreground ml-1">:{a.entityLabel ?? a.entityId.slice(0, 8)}</span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground max-w-xs truncate">{a.description}</td>
                    <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                      {formatDateTime(a.createdAt)} ({formatRelative(a.createdAt)})
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        {a.status === 'OPEN' && (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 px-0"
                              onClick={() => handleAction(a.id, 'acknowledge')}
                              disabled={actionLoading === a.id}
                              aria-label="Acknowledge"
                              title="Acknowledge"
                            >
                              <Check className="h-4 w-4 text-positive" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 px-0"
                              onClick={() => handleAction(a.id, 'dismiss')}
                              disabled={actionLoading === a.id}
                              aria-label="Dismiss"
                              title="Dismiss"
                            >
                              <X className="h-4 w-4 text-warning" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 px-0"
                              onClick={() => handleAction(a.id, 'confirm')}
                              disabled={actionLoading === a.id}
                              aria-label="Confirm"
                              title="Confirm (escalate)"
                            >
                              <AlertTriangle className="h-4 w-4 text-negative" />
                            </Button>
                          </>
                        )}
                        {a.status !== 'OPEN' && (
                          <span className="text-muted-foreground text-xs">
                            {a.status === 'ACKNOWLEDGED' && a.acknowledgedAt && `Acknowledged ${formatRelative(a.acknowledgedAt)}`}
                            {a.status === 'DISMISSED' && a.dismissedAt && `Dismissed ${formatRelative(a.dismissedAt)}`}
                            {a.status === 'CONFIRMED' && a.confirmedAt && `Confirmed ${formatRelative(a.confirmedAt)}`}
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between border-border-subtle border bg-white rounded-lg px-4 py-3">
              <span className="text-sm text-muted-foreground">
                Page {page} of {totalPages} — {formatInteger(total)} total
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}