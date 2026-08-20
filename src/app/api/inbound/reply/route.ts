import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { getInboundSecret } from '@/lib/env';
import { ingestInboundMessage } from '@/lib/services/inbound/ingest';
import type { RawInbound } from '@/lib/services/inbound/classify';

/**
 * POST /api/inbound/reply
 *
 * Where inbound mail enters the CRM. Called by the Cloudflare Email Worker in
 * `cloudflare/email-worker.js`, which is pure transport: it parses nothing and
 * decides nothing. All classification and attribution happen here, next to
 * `email_logs`, so there is exactly one definition of what a reply belongs to.
 *
 * Authorization is a shared secret, not a session ,there is no user. The route
 * sits outside the middleware's admin prefixes for that reason, which makes the
 * check below the only thing between the internet and the inbox. It fails
 * closed when no secret is configured.
 *
 * Body:
 *   {
 *     "from": "\"Ada\" <ada@example.com>",
 *     "to": "send@team-automationsolutions.me",
 *     "subject": "Re: Quick idea",
 *     "text": "Sounds interesting, can you send more?",
 *     "headers": { "message-id": "<...>", "in-reply-to": "<...>", ... }
 *   }
 *
 * Header keys must be lower-cased by the caller; the Worker does that.
 */

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  from: z.string().min(3).max(320),
  to: z.string().max(320).optional().nullable(),
  subject: z.string().max(1000).optional().nullable(),
  text: z.string().max(200_000).optional().nullable(),
  headers: z.record(z.string(), z.string()).optional(),
});

function isAuthorized(request: NextRequest): boolean {
  const expected = getInboundSecret();
  if (!expected) return false;

  const header = request.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (presented === '') return false;

  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length. Compare sizes first, then in constant time.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(request: NextRequest) {
  if (!getInboundSecret()) {
    return NextResponse.json(
      {
        ok: false,
        message:
          'INBOUND_SECRET (or CRON_SECRET) is not set on the server, so inbound mail is disabled.',
      },
      { status: 503 },
    );
  }

  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, message: 'Unauthorized.' }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, message: 'Body must include at least { from } and may include to, subject, text, headers.' },
      { status: 400 },
    );
  }

  const raw: RawInbound = {
    from: parsed.data.from,
    to: parsed.data.to ?? null,
    subject: parsed.data.subject ?? null,
    text: parsed.data.text ?? null,
    // Lower-case defensively: the classifier looks headers up by lower-cased
    // name, and a caller that forgets would silently match nothing.
    headers: Object.fromEntries(
      Object.entries(parsed.data.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    ),
  };

  const result = await ingestInboundMessage(raw);

  // A 5xx makes the Worker retry, so only genuine server failures get one.
  // Everything else ,unmatched, bounce, auto-reply ,is a successful ingest
  // with a different outcome, and retrying it would just duplicate work.
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
