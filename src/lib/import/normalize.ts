import type { Json } from '@/lib/supabase/database.types';

/** Trim, collapse internal whitespace, and treat blank as absent. */
export function cleanText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text === '' ? null : text;
}

/** Same, but preserves newlines for research prose and draft bodies. */
export function cleanMultiline(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  return text === '' ? null : text;
}

export const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

/**
 * Scraper artefacts and template placeholders that appear in the workbook.
 *
 * These matter more than they look: the importer treats email as the identity
 * of a lead, so leaving them in would collapse nine unrelated businesses into
 * one record under a Wix error-reporting address.
 */
const JUNK_EMAIL_DOMAINS = [
  /wixpress\.com$/i,
  /(^|\.)sentry\./i,
  /(^|\.)sentry\.io$/i,
  /(^|\.)example\.(com|org|net)$/i,
  /(^|\.)domain\.com$/i,
  /(^|\.)yourdomain\.com$/i,
  /(^|\.)email\.com$/i,
  /(^|\.)here\.com$/i,
  /(^|\.)origin\.com$/i,
  /(^|\.)test\.(com|org)$/i,
];

const JUNK_EMAIL_LOCAL_PARTS = [
  /^user$/i,
  /^your$/i,
  /^youremail$/i,
  /^your\.?email$/i,
  /^email$/i,
  /^name$/i,
  /^example$/i,
  /^test$/i,
  /^info$/i, // only junk when paired with a junk domain see isJunkEmail
];

export function isJunkEmail(email: string): boolean {
  const [localPart, domain] = email.toLowerCase().split('@');
  if (!localPart || !domain) return true;

  if (JUNK_EMAIL_DOMAINS.some((re) => re.test(domain))) return true;

  // A generic local part is only suspicious next to a placeholder domain;
  // info@realbusiness.com is a perfectly good lead.
  const genericLocal = JUNK_EMAIL_LOCAL_PARTS.some((re) => re.test(localPart));
  const placeholderDomain = /^(domain|example|test|email|here|origin|yourdomain)\./i.test(
    `${domain}.`,
  );
  return genericLocal && placeholderDomain;
}

export interface EmailResult {
  email: string | null;
  /** Set when a value was present but discarded. */
  warning: string | null;
}

export function normalizeEmail(value: unknown): EmailResult {
  const raw = cleanText(value);
  if (!raw) return { email: null, warning: null };

  // Some cells hold several addresses; take the first usable one.
  const candidate = raw.split(/[;,\s]+/).find((part) => part.includes('@'))?.toLowerCase() ?? null;

  if (!candidate || !EMAIL_PATTERN.test(candidate)) {
    return { email: null, warning: `Discarded unparseable email ${JSON.stringify(raw)}` };
  }
  if (isJunkEmail(candidate)) {
    return { email: null, warning: `Discarded placeholder/scraper email ${JSON.stringify(candidate)}` };
  }
  return { email: candidate, warning: null };
}

export interface WebsiteResult {
  website: string | null;
  warning: string | null;
}

export function normalizeWebsite(value: unknown): WebsiteResult {
  const raw = cleanText(value);
  if (!raw) return { website: null, warning: null };

  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (!url.hostname.includes('.')) {
      return { website: null, warning: `Discarded website without a valid host: ${JSON.stringify(raw)}` };
    }
    return { website: url.toString(), warning: null };
  } catch {
    return { website: null, warning: `Discarded unparseable website ${JSON.stringify(raw)}` };
  }
}

export function normalizePhone(value: unknown): string | null {
  const raw = cleanText(value);
  if (!raw) return null;
  // Kept as free text: these are international numbers in many local formats
  // and reformatting them would lose information.
  return raw.slice(0, 64);
}

/**
 * Excel serial date -> JS Date (1900 date system).
 *
 * Excel believes 1900 was a leap year, so serial 60 is a date that never
 * existed (1900-02-29) and everything from 61 onward is shifted a day. The
 * usual 1899-12-30 epoch bakes in that shift, which is right for serial >= 61
 * and a day out below it hence the split. Any real spreadsheet date is far
 * above 61, but getting this wrong silently is exactly the sort of bug that
 * shows up later as "all our dates are off by one".
 */
function excelSerialToDate(serial: number): Date | null {
  if (!Number.isFinite(serial) || serial <= 0 || serial > 2_958_465) return null;
  if (serial === 60) return null; // 1900-02-29 does not exist

  const epoch = serial < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
  return new Date(epoch + Math.round(serial * 86_400_000));
}

/**
 * The workbook mixes three representations in the same column: real dates,
 * raw Excel serials, and DD-MM-YYYY text.
 */
export function normalizeDate(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  if (typeof value === 'number') {
    return excelSerialToDate(value)?.toISOString() ?? null;
  }

  const text = String(value).trim();
  if (text === '') return null;

  if (/^\d+(\.\d+)?$/.test(text)) {
    return excelSerialToDate(Number(text))?.toISOString() ?? null;
  }

  // DD-MM-YYYY or DD/MM/YYYY day-first, matching the workbook.
  const dayFirst = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (dayFirst) {
    const [, d, m, y] = dayFirst;
    const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Loose yes/no reading of the workbook's status columns. */
export function isAffirmative(value: unknown): boolean {
  const text = cleanText(value)?.toLowerCase();
  if (!text) return false;
  return ['yes', 'y', 'true', 'done', 'sent', 'complete', 'completed', '1'].includes(text);
}

/**
 * Social links arrive as JSON, as truncated JSON, or as an English sentence
 * ("No social media links were found"). Anything unparseable is preserved
 * under `_raw` so no source data is silently dropped.
 */
export function normalizeSocialLinks(value: unknown): Json {
  const raw = cleanText(value);
  if (!raw) return {};

  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const entries = Object.entries(parsed as Record<string, unknown>)
        .filter(([, v]) => typeof v === 'string' && v.trim() !== '')
        .map(([k, v]) => [k.toLowerCase().trim(), String(v).trim()]);
      return Object.fromEntries(entries) as Json;
    }
  } catch {
    // fall through
  }

  return { _raw: raw.slice(0, 2000) } as Json;
}
