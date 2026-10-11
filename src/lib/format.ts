import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Presentation-only formatters.
 *
 * Deliberately NOT money formatting: there is no currency conversion or rounding
 * decision here, because those belong to lib/money and must be decided once with
 * the ledger, not per component. Amounts render through formatAmount below,
 * which is display-only and never feeds a calculation.
 */

const NUMBER_FORMAT = new Intl.NumberFormat('en-GB', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const INTEGER_FORMAT = new Intl.NumberFormat('en-GB');

export function formatAmount(value: number | string | null | undefined, currency?: string): string {
  if (value === null || value === undefined || value === '') return '-';
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return '-';
  const formatted = NUMBER_FORMAT.format(n);
  return currency ? `${currency} ${formatted}` : formatted;
}

export function formatInteger(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '-';
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return '-';
  return INTEGER_FORMAT.format(n);
}

export function formatDateTime(value: Date | string | null | undefined): string {
  if (!value) return '-';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '-';
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(d);
}

export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return '-';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '-';
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(d);
}

/** Truncates a long identifier for display without hiding that it is truncated. */
export function shortId(id: string | null | undefined, length = 8): string {
  if (!id) return '-';
  return id.length <= length ? id : `${id.slice(0, length)}...`;
}

/** Formats a date as a relative time (e.g., "2 hours ago"). */
export function formatRelative(value: Date | string | null | undefined): string {
  if (!value) return '-';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '-';
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return formatDate(d);
}
