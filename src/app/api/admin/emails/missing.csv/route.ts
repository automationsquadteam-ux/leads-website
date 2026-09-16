import { NextResponse } from 'next/server';

import { assertAdmin } from '@/lib/auth/session';
import { getLeadsMissingEmail, toCsv } from '@/lib/services/email-verification';

/**
 * GET /api/admin/emails/missing.csv
 *
 * Leads with no email address, with what's useful for finding one and a
 * blank `email` column to fill in and hand straight back through the upload
 * below it ,`importFoundEmailsCsv()` matches rows on business_name + city +
 * country + niche against `getLeadsMissingEmail()`, the same query this file
 * runs, so the two halves of the round trip can never disagree about which
 * leads are in scope.
 *
 * `website` was dropped on 2026-08-18 and asked back on 2026-09-16 ,it is
 * where the address is usually found. Phone stays out. `social` (the first
 * usable link out of `social_links`) is there for the leads whose only web
 * presence is a Facebook or Instagram page.
 *
 * The upload ignores `website` and `social`; it matches on the other four.
 */

export const dynamic = 'force-dynamic';

/** First usable http link out of the social_links jsonb. */
function firstSocial(links: unknown): string {
  if (!links || typeof links !== 'object') return '';
  for (const [key, value] of Object.entries(links as Record<string, unknown>)) {
    if (key === '_raw') continue;
    if (typeof value === 'string' && value.startsWith('http')) return value;
  }
  return '';
}

export async function GET() {
  try {
    await assertAdmin();
  } catch {
    return NextResponse.json({ ok: false, message: 'Unauthorized.' }, { status: 401 });
  }

  const rows = await getLeadsMissingEmail();
  rows.sort((a, b) => a.business_name.localeCompare(b.business_name));

  const csv = toCsv(
    ['business_name', 'website', 'city', 'country', 'niche', 'social', 'email'],
    rows.map((r) => [
      r.business_name,
      r.website,
      r.city,
      r.country,
      r.niche,
      firstSocial(r.social_links),
      // Left blank on purpose: fill it in and hand the file back.
      '',
    ]),
  );

  const stamp = new Date().toISOString().slice(0, 10);

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="leads-missing-email-${stamp}.csv"`,
      // Business details: never let a proxy or the browser keep a copy.
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Row-Count': String(rows.length),
    },
  });
}
