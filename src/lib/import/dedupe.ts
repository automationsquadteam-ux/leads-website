/**
 * Lead identity.
 *
 * The brief: "Use the email as the unique identifier if available; otherwise
 * use website or business name." That is `key-mode=email` below, and it is the
 * default.
 *
 * Caveat worth knowing about this dataset: a handful of rows are distinct
 * businesses that share one contact address (two Chiang Mai agencies both on
 * info@faranghomes.com, for example). Under the email rule those collapse into
 * a single lead. The importer reports every collapse rather than hiding it, and
 * `key-mode=business` is available when you would rather keep them apart.
 */

export type KeyMode = 'email' | 'business';

export interface KeySource {
  email: string | null;
  website: string | null;
  businessName: string;
  city: string | null;
}

function normalizeHost(website: string): string {
  try {
    const url = new URL(website);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const path = url.pathname.replace(/\/+$/, '');
    return `${host}${path}`;
  } catch {
    return website.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
  }
}

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // drop punctuation: "Co., Ltd." vs "Co Ltd"
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Stable, prefixed identity string stored in leads.dedupe_key (UNIQUE).
 * The prefix keeps the three namespaces from ever colliding.
 */
export function buildDedupeKey(source: KeySource, mode: KeyMode = 'email'): string {
  const nameKey = () => {
    const name = normalizeName(source.businessName);
    const city = source.city ? normalizeName(source.city) : '';
    return `name:${name}|${city}`;
  };

  if (mode === 'business') return nameKey();

  if (source.email) return `email:${source.email.toLowerCase().trim()}`;
  if (source.website) return `site:${normalizeHost(source.website)}`;
  return nameKey();
}
