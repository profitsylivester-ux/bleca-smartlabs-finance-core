'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';

interface SecurityEvent {
  id: string;
  type: string;
  severity: 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  subjectType: string | null;
  subjectId: string | null;
  subjectLabel: string | null;
  description: string;
  detail: Record<string, unknown> | null;
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
  acknowledgedAt: string | null;
  acknowledgedById: string | null;
  acknowledgementNote: string | null;
  resolvedAt: string | null;
  occurredAt: string;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface ApiResponse {
  data: SecurityEvent[];
  pagination: Pagination;
}

const severityColors: Record<SecurityEvent['severity'], string> = {
  INFO: 'bg-blue-100 text-blue-800',
  LOW: 'bg-green-100 text-green-800',
  MEDIUM: 'bg-yellow-100 text-yellow-800',
  HIGH: 'bg-orange-100 text-orange-800',
  CRITICAL: 'bg-red-100 text-red-800',
};

export default function SecurityEventsPage() {
  const searchParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const router = useRouter();
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 20, total: 0, totalPages: 0 });
  const [filters, setFilters] = useState({
    severity: searchParams.get('severity') || '',
    acknowledged: searchParams.get('acknowledged') || '',
    type: searchParams.get('type') || '',
  });

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        page: pagination.page.toString(),
        limit: pagination.limit.toString(),
      });
      if (filters.severity) params.set('severity', filters.severity);
      if (filters.acknowledged) params.set('acknowledged', filters.acknowledged);
      if (filters.type) params.set('type', filters.type);

      const response = await fetch(`/api/v1/security-events?${params}`);
      const data: ApiResponse = await response.json();

      if (!response.ok) {
        throw new Error((data as any).error || 'Failed to fetch events');
      }

      setEvents(data.data);
      setPagination(data.pagination);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load events');
    } finally {
      setLoading(false);
    }
  }, [pagination.page, pagination.limit, filters]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  const handleFilterChange = (key: string, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setPagination((prev) => ({ ...prev, page: 1 }));
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    params.set('page', '1');
    router.push(`/admin/security-events?${params.toString()}`);
  };

  const handleAcknowledge = async (event: SecurityEvent) => {
    const note = prompt('Acknowledgment note (required):');
    if (!note) return;

    try {
      const response = await fetch(`/api/v1/security-events/${event.id}/acknowledge`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `ack-${event.id}-${Date.now()}`,
        },
        body: JSON.stringify({ note }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to acknowledge');
      }

      fetchEvents();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to acknowledge');
    }
  };

  const handleResolve = async (event: SecurityEvent) => {
    const reason = prompt('Resolution reason (required):');
    if (!reason) return;

    try {
      const response = await fetch(`/api/v1/security-events/${event.id}/resolve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `resolve-${event.id}-${Date.now()}`,
        },
        body: JSON.stringify({ reason }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to resolve');
      }

      fetchEvents();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to resolve');
    }
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-gray-900">Security Events</h1>
        <div className="flex gap-2">
          <select
            value={filters.severity}
            onChange={(e) => handleFilterChange('severity', e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All Severities</option>
            <option value="CRITICAL">Critical</option>
            <option value="HIGH">High</option>
            <option value="MEDIUM">Medium</option>
            <option value="LOW">Low</option>
            <option value="INFO">Info</option>
          </select>
          <select
            value={filters.acknowledged}
            onChange={(e) => handleFilterChange('acknowledged', e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All</option>
            <option value="true">Acknowledged</option>
            <option value="false">Unacknowledged</option>
          </select>
          <input
            type="text"
            value={filters.type}
            onChange={(e) => handleFilterChange('type', e.target.value)}
            placeholder="Filter by type..."
            className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 w-48"
          />
        </div>
      </div>

      {error && (
        <div className="p-4 bg-red-50 text-red-800 rounded-lg">{error}</div>
      )}

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Occurred</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Type</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Severity</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Subject</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Description</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {loading ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                  Loading...
                </td>
              </tr>
            ) : events.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                  No security events found
                </td>
              </tr>
            ) : (
              events.map((event) => (
                <tr key={event.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm text-gray-900">{formatDate(event.occurredAt)}</td>
                  <td className="px-4 py-3 text-sm text-gray-900 font-mono text-xs">{event.type}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-1 text-xs font-medium rounded-full ${severityColors[event.severity]}`}>
                      {event.severity}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">
                    {event.subjectType && event.subjectId ? (
                      <>
                        <span className="font-mono text-xs">{event.subjectType}</span>
                        {event.subjectLabel && (
                          <span className="ml-1 text-gray-400">({event.subjectLabel})</span>
                        )}
                      </>
                    ) : (
                      <span className="text-gray-400">â€”</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-900 max-w-xs truncate">{event.description}</td>
                  <td className="px-4 py-3 text-sm">
                    {event.resolvedAt ? (
                      <span className="text-green-600">Resolved</span>
                    ) : event.acknowledgedAt ? (
                      <span className="text-yellow-600">Acknowledged</span>
                    ) : (
                      <span className="text-red-600">Open</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <div className="flex gap-2">
                      {!event.acknowledgedAt && (
                        <button
                          onClick={() => handleAcknowledge(event)}
                          className="px-2 py-1 text-xs bg-yellow-100 text-yellow-800 rounded hover:bg-yellow-200"
                        >
                          Acknowledge
                        </button>
                      )}
                      {!event.resolvedAt && event.acknowledgedAt && (
                        <button
                          onClick={() => handleResolve(event)}
                          className="px-2 py-1 text-xs bg-green-100 text-green-800 rounded hover:bg-green-200"
                        >
                          Resolve
                        </button>
                      )}
                      {event.resolvedAt && (
                        <span className="px-2 py-1 text-xs bg-gray-100 text-gray-600 rounded">Done</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        {pagination.totalPages > 1 && (
          <div className="px-4 py-3 border-t border-gray-200 flex items-center justify-between">
            <p className="text-sm text-gray-600">
              Page {pagination.page} of {pagination.totalPages} ({pagination.total} total)
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setPagination((p) => ({ ...p, page: p.page - 1 }))}
                disabled={pagination.page === 1}
                className="px-3 py-1 text-sm border border-gray-300 rounded disabled:opacity-50"
              >
                Previous
              </button>
              <button
                onClick={() => setPagination((p) => ({ ...p, page: p.page + 1 }))}
                disabled={pagination.page === pagination.totalPages}
                className="px-3 py-1 text-sm border border-gray-300 rounded disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
