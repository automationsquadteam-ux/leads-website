import 'server-only';

import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';

import { getCronSecret } from '@/lib/env';

/**
 * The shared secret check every /api/cron/* route runs first.
 *
 * These routes sit OUTSIDE the middleware's admin prefixes on purpose — there is
 * no user and no session behind a cron call — which makes this function the only
 * thing standing between the open internet and code that sends email, rewrites
 * leads from a spreadsheet and approves drafts. It lived inline in the outreach
 * route; a second and third copy of a security check is how one of them ends up
 * subtly different, so it moved here the moment there was more than one caller.
 *
 * It fails closed: no CRON_SECRET means every cron route is disabled, not open.
 */
function isAuthorized(request: NextRequest): boolean {
  const expected = getCronSecret();
  if (!expected) return false;

  const header = request.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (presented === '') return false;

  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length — compare sizes first and only then in constant time.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Returns a response to send back when the request must be refused, or `null`
 * when the caller may proceed. Written this way so a route reads as
 *
 *     const refusal = guardCronRequest(request);
 *     if (refusal) return refusal;
 *
 * which is hard to get wrong by accident.
 */
export function guardCronRequest(request: NextRequest, job: string): NextResponse | null {
  if (!getCronSecret()) {
    return NextResponse.json(
      {
        ok: false,
        message: `CRON_SECRET is not set on the server, so the scheduled ${job} is disabled. Add it to the environment and redeploy.`,
      },
      { status: 503 },
    );
  }

  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, message: 'Unauthorized.' }, { status: 401 });
  }

  return null;
}
