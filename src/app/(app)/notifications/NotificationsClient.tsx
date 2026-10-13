'use client';

import { useState, useEffect, useCallback } from 'react';
import { Bell, Check, ChevronRight, Filter, X } from 'lucide-react';
import { Button } from '@/components/ui';
import { formatDateTime, formatRelative, formatInteger } from '@/lib/format';
import { Badge } from '@/components/ui';

interface Notification {
  id: string;
  category: string;
  severity: string;
  channel: string;
  status: string;
  title: string;
  body: string;
  actionUrl: string | null;
  entityType: string | null;
  entityId: string | null;
  createdAt: string;
  readAt: string | null;
}

export function NotificationsClient() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('');

  const fetchNotifications = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filter === 'unread') params.set('unreadOnly', 'true');
      if (categoryFilter) params.set('category', categoryFilter);

      const res = await fetch(`/api/v1/notifications?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to fetch notifications');
      const data = await res.json();
      setNotifications(data.data);
      setUnreadCount(data.unread);
    } catch (err) {
      console.error('Failed to load notifications:', err);
    } finally {
      setLoading(false);
    }
  }, [filter, categoryFilter]);

  useEffect(() => {
    fetchNotifications();
  }, [fetchNotifications]);

  const handleMarkRead = async (id: string) => {
    try {
      const res = await fetch(`/api/v1/notifications/${id}/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error('Failed to mark as read');

      setNotifications((prev) =>
        prev.map((n) => (n.id === id ? { ...n, status: 'READ', readAt: new Date().toISOString() } : n)),
      );
      setUnreadCount((prev) => Math.max(0, prev - 1));
    } catch (err) {
      console.error('Failed to mark notification as read:', err);
    }
  };

  const handleMarkAllRead = async () => {
    try {
      const res = await fetch('/api/v1/notifications/read-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: categoryFilter || undefined }),
      });
      if (!res.ok) throw new Error('Failed to mark all as read');

      setNotifications((prev) =>
        prev.map((n) => (n.status !== 'READ' ? { ...n, status: 'READ', readAt: new Date().toISOString() } : n)),
      );
      setUnreadCount(0);
    } catch (err) {
      console.error('Failed to mark all notifications as read:', err);
    }
  };

  const getCategoryLabel = (cat: string) => {
    const labels: Record<string, string> = {
      APPROVAL: 'Approval',
      BUDGET_ALERT: 'Budget Alert',
      PAYMENT_REMINDER: 'Payment Reminder',
      COMPLIANCE_ALERT: 'Compliance Alert',
      COMPLIANCE_EXPIRY: 'Compliance Expiry',
      SECURITY_ALERT: 'Security Alert',
      ACCESS_REVIEW: 'Access Review',
      DOCUMENT_EXPIRY: 'Document Expiry',
      PERIOD_CLOSE: 'Period Close',
      RECONCILIATION: 'Reconciliation',
      STATEMENT_IMPORT: 'Statement Import',
      OVER_BUDGET: 'Over Budget',
      ANOMALY: 'Anomaly',
      SYSTEM: 'System',
      REPORT_READY: 'Report Ready',
      ACCOUNT: 'Account',
    };
    return labels[cat] ?? cat;
  };

  const getSeverityBadge = (severity: string) => {
    switch (severity) {
      case 'CRITICAL':
        return <Badge tone="danger">{severity}</Badge>;
      case 'WARNING':
        return <Badge tone="warning">{severity}</Badge>;
      case 'SUCCESS':
        return <Badge tone="success">{severity}</Badge>;
      default:
        return <Badge tone="info">{severity}</Badge>;
    }
  };

  const categories = Array.from(new Set(notifications.map((n) => n.category))).sort();

  if (loading) {
    return (
      <div className="border-border-subtle rounded-lg border bg-white p-8 text-center text-muted-foreground">
        Loading notifications…
      </div>
    );
  }

  const filteredNotifications = notifications;

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-border-subtle border bg-white rounded-lg p-4">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium">Show:</span>
          <div className="flex items-center gap-1 border-border-subtle border rounded-md p-1">
            <Button
              variant={filter === 'all' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setFilter('all')}
            >
              All
            </Button>
            <Button
              variant={filter === 'unread' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setFilter('unread')}
            >
              <Bell className="h-3.5 w-3.5 mr-1" />
              Unread ({unreadCount})
            </Button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="border-border-subtle border rounded-md px-3 py-1.5 text-sm bg-white"
          >
            <option value="">All categories</option>
            {categories.map((cat) => (
              <option key={cat} value={cat}>
                {getCategoryLabel(cat)}
              </option>
            ))}
          </select>
          {unreadCount > 0 && (
            <Button variant="outline" size="sm" onClick={handleMarkAllRead}>
              <Check className="h-3.5 w-3.5 mr-1" />
              Mark all read
            </Button>
          )}
        </div>
      </div>

      {/* List */}
      {filteredNotifications.length === 0 ? (
        <div className="border-border-subtle rounded-lg border bg-white p-8 text-center text-muted-foreground">
          {filter === 'unread' ? 'No unread notifications.' : 'No notifications yet.'}
        </div>
      ) : (
        <div className="border-border-subtle rounded-lg border bg-white divide-border-subtle divide-y">
          {filteredNotifications.map((n) => (
            <div
              key={n.id}
              className={`px-5 py-4 flex flex-wrap items-start justify-between gap-3 transition-colors ${
                n.status !== 'READ' ? 'bg-navy-50' : ''
              }`}
            >
              <div className="flex-1 min-w-0 flex flex-col gap-2">
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium truncate">{n.title}</span>
                      <Badge tone="neutral" className="text-xs">
                        {getCategoryLabel(n.category)}
                      </Badge>
                      {getSeverityBadge(n.severity)}
                      <Badge tone="neutral" className="text-xs">{n.channel}</Badge>
                      {n.status !== 'READ' && (
                        <span className="h-2 w-2 rounded-full bg-navy-600 shrink-0" aria-label="Unread" />
                      )}
                    </div>
                    <p className="text-muted-foreground text-sm mt-1">{n.body}</p>
                    {n.actionUrl && (
                      <a
                        href={n.actionUrl}
                        className="text-navy-600 hover:text-navy-800 underline underline-offset-2 text-sm mt-2 inline-block"
                      >
                        Open →
                      </a>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span>
                    {formatDateTime(n.createdAt)} ({formatRelative(n.createdAt)})
                  </span>
                  {n.entityType && n.entityId && (
                    <span className="mono">{n.entityType}:{n.entityId.slice(0, 8)}</span>
                  )}
                </div>
              </div>
              {n.status !== 'READ' && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 px-0 shrink-0"
                  onClick={() => handleMarkRead(n.id)}
                  aria-label="Mark as read"
                >
                  <Check className="h-4 w-4" />
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}