'use client';

import { useState, useEffect, useCallback } from 'react';
import { Bell, Mail, Smartphone, Save, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui';
import { Badge } from '@/components/ui';

interface Preference {
  id: string;
  userId: string;
  category: string;
  channel: string;
  enabled: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  updatedAt: string;
}

const CATEGORIES = [
  'APPROVAL',
  'BUDGET_ALERT',
  'PAYMENT_REMINDER',
  'COMPLIANCE_ALERT',
  'COMPLIANCE_EXPIRY',
  'SECURITY_ALERT',
  'ACCESS_REVIEW',
  'DOCUMENT_EXPIRY',
  'PERIOD_CLOSE',
  'RECONCILIATION',
  'STATEMENT_IMPORT',
  'OVER_BUDGET',
  'ANOMALY',
  'SYSTEM',
  'REPORT_READY',
  'ACCOUNT',
] as const;

const CHANNELS = ['IN_APP', 'EMAIL', 'SMS', 'PUSH'] as const;

const CATEGORY_LABELS: Record<string, string> = {
  APPROVAL: 'Approvals',
  BUDGET_ALERT: 'Budget alerts',
  PAYMENT_REMINDER: 'Payment reminders',
  COMPLIANCE_ALERT: 'Compliance alerts',
  COMPLIANCE_EXPIRY: 'Compliance expiry',
  SECURITY_ALERT: 'Security alerts',
  ACCESS_REVIEW: 'Access reviews',
  DOCUMENT_EXPIRY: 'Document expiry',
  PERIOD_CLOSE: 'Period close',
  RECONCILIATION: 'Reconciliation',
  STATEMENT_IMPORT: 'Statement import',
  OVER_BUDGET: 'Over budget',
  ANOMALY: 'Anomalies',
  SYSTEM: 'System',
  REPORT_READY: 'Report ready',
  ACCOUNT: 'Account',
};

const CHANNEL_ICONS: Record<string, React.ReactNode> = {
  IN_APP: <Bell className="h-4 w-4" />,
  EMAIL: <Mail className="h-4 w-4" />,
  SMS: <Smartphone className="h-4 w-4" />,
  PUSH: <Smartphone className="h-4 w-4" />,
};

export function PreferencesClient() {
  const [preferences, setPreferences] = useState<Preference[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const fetchPreferences = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/v1/notification-preferences');
      if (!res.ok) throw new Error('Failed to fetch preferences');
      const data = await res.json();
      setPreferences(data.data);
    } catch (err) {
      console.error('Failed to load preferences:', err);
      setMessage({ type: 'error', text: 'Failed to load preferences' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPreferences();
  }, [fetchPreferences]);

  const handleToggle = (category: string, channel: string) => {
    setPreferences((prev) =>
      prev.map((p) =>
        p.category === category && p.channel === channel ? { ...p, enabled: !p.enabled } : p,
      ),
    );
  };

  const handleQuietHoursChange = (category: string, channel: string, field: 'start' | 'end', value: string) => {
    setPreferences((prev) =>
      prev.map((p) =>
        p.category === category && p.channel === channel
          ? { ...p, [`quietHours${field === 'start' ? 'Start' : 'End'}`]: value || null }
          : p,
      ),
    );
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch('/api/v1/notification-preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferences }),
      });
      if (!res.ok) throw new Error('Failed to save preferences');
      setMessage({ type: 'success', text: 'Preferences saved successfully' });
      await fetchPreferences();
    } catch (err) {
      console.error('Failed to save preferences:', err);
      setMessage({ type: 'error', text: 'Failed to save preferences' });
    } finally {
      setSaving(false);
    }
  };

  const getPref = (category: string, channel: string) => {
    return preferences.find((p) => p.category === category && p.channel === channel);
  };

  if (loading) {
    return (
      <div className="border-border-subtle rounded-lg border bg-white p-8 text-center text-muted-foreground">
        Loading preferences…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {message && (
        <div
          className={`p-3 rounded-md text-sm ${
            message.type === 'success' ? 'bg-success/10 text-success' : 'bg-negative/10 text-negative'
          }`}
        >
          {message.text}
        </div>
      )}

      <div className="border-border-subtle rounded-lg border bg-white overflow-hidden">
        {/* Header */}
        <div className="border-border-subtle border-b px-5 py-3 sticky top-0 bg-white z-10">
          <div className="grid grid-cols-6 gap-4 text-xs font-medium text-muted-foreground">
            <div className="col-span-2">Category</div>
            {CHANNELS.map((ch) => (
              <div key={ch} className="flex items-center justify-center gap-1">
                {CHANNEL_ICONS[ch]}
                <span>{ch}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Rows */}
        <div className="divide-border-subtle divide-y max-h-[60vh] overflow-y-auto">
          {CATEGORIES.map((category) => (
            <div key={category} className="px-5 py-3 grid grid-cols-6 gap-4 items-center">
              <div className="col-span-2">
                <span className="font-medium">{CATEGORY_LABELS[category]}</span>
              </div>
              {CHANNELS.map((channel) => {
                const pref = getPref(category, channel);
                const isEnabled = pref?.enabled ?? (channel === 'IN_APP'); // IN_APP defaults to on
                const quietStart = pref?.quietHoursStart ?? null;
                const quietEnd = pref?.quietHoursEnd ?? null;

                return (
                  <div
                    key={channel}
                    className="flex flex-col items-center gap-1.5"
                    style={{ opacity: channel !== 'IN_APP' && !isEnabled ? 0.5 : 1 }}
                  >
                    <label className="flex items-center justify-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={isEnabled}
                        onChange={() => handleToggle(category, channel)}
                        disabled={channel === 'IN_APP'} // IN_APP cannot be disabled
                        className="h-4 w-4 rounded border-border-subtle text-navy-600 focus:ring-navy-500"
                      />
                      <span className="sr-only">{CATEGORY_LABELS[category]} via {channel}</span>
                    </label>
                    {(channel === 'EMAIL' || channel === 'SMS' || channel === 'PUSH') && isEnabled && (
                      <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                        <label className="flex items-center gap-1 cursor-pointer" title="Quiet hours start">
                          <input
                            type="time"
                            value={quietStart ?? ''}
                            onChange={(e) => handleQuietHoursChange(category, channel, 'start', e.target.value)}
                            className="border-border-subtle border rounded px-1.5 py-0.5 text-xs bg-white"
                          />
                        </label>
                        <span>–</span>
                        <label className="flex items-center gap-1 cursor-pointer" title="Quiet hours end">
                          <input
                            type="time"
                            value={quietEnd ?? ''}
                            onChange={(e) => handleQuietHoursChange(category, channel, 'end', e.target.value)}
                            className="border-border-subtle border rounded px-1.5 py-0.5 text-xs bg-white"
                          />
                        </label>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="border-border-subtle border-t px-5 py-4 bg-white/50 flex justify-end">
          <Button onClick={handleSave} disabled={saving} className="w-auto">
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Saving…
              </>
            ) : (
              <>
                <Save className="h-4 w-4 mr-2" />
                Save preferences
              </>
            )}
          </Button>
        </div>
      </div>

      <p className="text-muted-foreground text-xs">
        In-app notifications are always enabled. Email, SMS and Push can be toggled per category. Quiet hours
        suppress delivery during the specified time window (local time).
      </p>
    </div>
  );
}