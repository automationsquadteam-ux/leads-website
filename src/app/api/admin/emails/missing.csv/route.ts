import { NextResponse } from 'next/server';

import { assertAdmin } from '@/lib/auth/session';
import { createServiceClient } from '@/lib/supabase/service-client';
import { toCsv } from '@/lib/services/email-verification';

/**
 * GET /api/admin/emails/missing.csv
 *
 * Leads with no email address, with everything useful for finding one.
 *
 * The columns are chosen for the job rather than for completeness: a website is
 * where you look first (`/contact`, `/about`, the privacy policy), social links
 * are second, and a phone number means you can just ask. A blank `email` column
 * is included deliberately so the file can be filled in and handed straight
 * back to the sheet.
 *
 * Sorted by whether there is a website, because a lead with one is far quicker
 * to resolve than a lead with nothing but a name.
 */

export const dynamic = 'force-dynamic';

interface Row {
  business_name: string;
  website: string | null;
  phone: string | null;
  city: string | null;
  country: string | null;
  niche: string | null;
  social_links: unknown;
}

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

  const admin = createServiceClient();

  // Which leads have no address is the pipeline's answer, not the lead table's,
  // so that this file always matches the "No email" count and view.
  const ids: string[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await admin
      .from('lead_pipeline')
      .select('lead_id')
      .eq('email_found', false)
      .is('closed', null)
      .order('lead_id', { ascending: true })
      .range(from, from + 999);

    const batch = data ?? [];
    ids.push(...batch.map((r) => r.lead_id));
    if (batch.length < 1000) break;
  }

  const rows: Row[] = [];
  for (let i = 0; i < ids.length; i += 300) {
    const { data } = await admin
      .from('leads')
      .select('business_name, website, phone, city, country, niche, social_links, status')
      .in('id', ids.slice(i, i + 300));

    for (const lead of data ?? []) {
      if (lead.status === 'archived' || lead.status === 'invalid') continue;
      rows.push(lead as Row);
    }
  }

  // A website is the fastest route to an address, so those come first.
  rows.sort((a, b) => {
    const aWeb = a.website ? 0 : 1;
    const bWeb = b.website ? 0 : 1;
    return aWeb - bWeb || a.business_name.localeCompare(b.business_name);
  });

  const csv = toCsv(
    ['business_name', 'website', 'phone', 'city', 'country', 'niche', 'social', 'email'],
    rows.map((r) => [
      r.business_name,
      r.website,
      r.phone,
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
