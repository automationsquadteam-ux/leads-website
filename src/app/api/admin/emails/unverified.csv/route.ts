import { NextResponse } from 'next/server';

import { assertAdmin } from '@/lib/auth/session';
import { buildUnverifiedCsv } from '@/lib/services/email-verification';

/**
 * GET /api/admin/emails/unverified.csv
 *
 * Every address with no definite verdict, as a CSV ready to upload to
 * NeverBounce (or ZeroBounce, or Bouncer ,the importer normalises all of
 * their result vocabularies).
 *
 * A route handler rather than a Server Action because this is a file download.
 * An action would have to marshal the whole CSV back through React and
 * reconstruct a Blob client-side; a plain link and a Content-Disposition header
 * lets the browser do what it already does well, and the link keeps working if
 * someone bookmarks it.
 *
 * `/api/admin` is in the middleware's ADMIN_PREFIXES, but middleware is not a
 * security boundary for a route handler ,assertAdmin() below is, and RLS is
 * the backstop under that.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    await assertAdmin();
  } catch {
    return NextResponse.json({ ok: false, message: 'Unauthorized.' }, { status: 401 });
  }

  // `?recheck=1` also exports catch-all and unknown addresses. Off by default:
  // a verifier bills per address, and a catch-all domain returns catch-all
  // every time, so re-exporting them by default charges again for an answer
  // that cannot change.
  const recheck = new URL(request.url).searchParams.get('recheck') === '1';
  const { csv, count } = await buildUnverifiedCsv({ includeInconclusive: recheck });

  if (count === 0) {
    // Still a CSV, so the download behaves predictably rather than erroring.
    // The header row alone tells the operator there was nothing to send.
    return new NextResponse('email,business_name,city,country\r\n', {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="unverified-emails-none.csv"',
      },
    });
  }

  const stamp = new Date().toISOString().slice(0, 10);

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="unverified-emails-${stamp}.csv"`,
      // Contains real addresses: never let a proxy or the browser keep a copy.
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Unverified-Count': String(count),
    },
  });
}
