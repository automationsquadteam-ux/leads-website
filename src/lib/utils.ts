import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge conditional classes, letting later Tailwind utilities win. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 1234 -> "1,234" */
export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('en-US').format(value);
}

/** 12.345 -> "12.3%" */
export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${value.toFixed(digits)}%`;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/** "3 days ago" / "in 2 hours" — falls back to a date beyond a month. */
export function formatRelative(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';

  const diffMs = date.getTime() - Date.now();
  const abs = Math.abs(diffMs);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (abs < minute) return 'just now';
  if (abs < hour) return rtf.format(Math.round(diffMs / minute), 'minute');
  if (abs < day) return rtf.format(Math.round(diffMs / hour), 'hour');
  if (abs < 30 * day) return rtf.format(Math.round(diffMs / day), 'day');
  return formatDate(value);
}

export function truncate(value: string | null | undefined, length: number): string {
  if (!value) return '';
  return value.length <= length ? value : `${value.slice(0, length).trimEnd()}…`;
}

/** Strip the scheme so tables can show "example.com/path" instead of the full URL. */
export function displayUrl(url: string | null | undefined): string {
  if (!url) return '';
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

export function initials(value: string | null | undefined): string {
  if (!value) return '?';
  const parts = value.replace(/@.*$/, '').split(/[\s._-]+/).filter(Boolean);
  return (parts.slice(0, 2).map((p) => p[0]).join('') || value[0] || '?').toUpperCase();
}
