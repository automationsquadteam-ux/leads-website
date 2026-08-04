/**
 * Cloudflare Email Worker — inbound mail transport for the Leads CRM.
 *
 * This is TRANSPORT ONLY. It parses no meaning, matches nothing and decides
 * nothing. It reads the headers, grabs the plain-text body, POSTs both to the
 * CRM, and forwards the message on to a human mailbox so nothing is swallowed.
 *
 * Everything that matters — is this a bounce, an out-of-office or a real reply,
 * and which lead does it belong to — happens in the CRM next to `email_logs`,
 * because that is where the Message-IDs we sent are recorded. Splitting that
 * logic across two systems is how you end up with two answers.
 *
 * ---------------------------------------------------------------------------
 * DEPLOY
 * ---------------------------------------------------------------------------
 * 1. Install wrangler if you have not:  npm i -g wrangler   (then: wrangler login)
 *
 * 2. From this directory:
 *      wrangler deploy
 *
 * 3. Set the secrets (they are prompted for, never committed):
 *      wrangler secret put CRM_INBOUND_URL
 *        -> https://<your-host>/api/inbound/reply
 *      wrangler secret put CRM_INBOUND_SECRET
 *        -> the same value as INBOUND_SECRET (or CRON_SECRET) on the CRM
 *      wrangler secret put FORWARD_TO
 *        -> your Gmail address, so replies still reach you personally.
 *           It MUST already be a verified destination in
 *           Cloudflare → Email → Email Routing → Destination addresses.
 *
 * 4. Cloudflare dashboard → your domain → Email → Email Routing → Routes.
 *    Edit the rule for send@team-automationsolutions.me and change the action
 *    from "Send to an email" to "Send to a Worker", picking this Worker.
 *
 * 5. Test: reply to one of your own sent emails FROM A DIFFERENT ADDRESS than
 *    the one you mailed. That is the case From-address matching cannot handle
 *    and threading can, so it proves the whole chain.
 *
 * ---------------------------------------------------------------------------
 * NOTES
 * ---------------------------------------------------------------------------
 * - Throwing makes Cloudflare retry the message, so a CRM outage means mail is
 *   redelivered rather than lost. The forward happens BEFORE the POST for that
 *   reason: a retry must never duplicate the copy that reaches your inbox.
 *   Duplicate POSTs are safe — the CRM de-duplicates on Message-ID.
 * - `message.raw` is a stream and can only be consumed once. It is read into a
 *   string here and reused; do not read it twice.
 * - Body extraction is deliberately simple. Full MIME parsing belongs on the
 *   server, and the CRM already strips quoted text and normalises whitespace.
 */

/** Message-ID headers can repeat; take them all, ordered. */
function collectHeaders(headers) {
  const out = {};
  for (const [key, value] of headers) {
    const name = key.toLowerCase();
    // Repeated headers (Received, References) are joined rather than
    // overwritten, so nothing is silently dropped.
    out[name] = out[name] ? `${out[name]} ${value}` : value;
  }
  return out;
}

/**
 * Pull a readable plain-text body out of the raw message.
 *
 * Prefers the text/plain MIME part. Falls back to everything after the header
 * block, which is correct for a simple non-multipart message and merely noisy
 * for anything else — the CRM strips quoted text and truncates, so noise is
 * cheap and a missing body is not.
 */
function extractText(raw) {
  const boundaryMatch = raw.match(/boundary="?([^"\r\n;]+)"?/i);

  if (boundaryMatch) {
    const parts = raw.split(`--${boundaryMatch[1]}`);
    for (const part of parts) {
      if (!/content-type:\s*text\/plain/i.test(part)) continue;

      const split = part.indexOf('\r\n\r\n');
      const body = split >= 0 ? part.slice(split + 4) : part;

      if (/content-transfer-encoding:\s*base64/i.test(part)) {
        try {
          return atob(body.replace(/\s+/g, ''));
        } catch {
          // Fall through to the raw text rather than losing the message.
        }
      }
      if (/content-transfer-encoding:\s*quoted-printable/i.test(part)) {
        return body
          .replace(/=\r?\n/g, '')
          .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
      }
      return body.trim();
    }
  }

  const split = raw.indexOf('\r\n\r\n');
  return split >= 0 ? raw.slice(split + 4).trim() : raw;
}

export default {
  async email(message, env) {
    // Forward first. A later failure makes Cloudflare retry the whole message,
    // and forwarding after the POST would mean a retry delivers a second copy
    // to the human mailbox every time the CRM hiccups.
    if (env.FORWARD_TO) {
      try {
        await message.forward(env.FORWARD_TO);
      } catch (error) {
        // A forwarding failure (unverified destination, usually) must not stop
        // the CRM from learning about the reply.
        console.error('forward failed:', error?.message ?? error);
      }
    }

    if (!env.CRM_INBOUND_URL || !env.CRM_INBOUND_SECRET) {
      console.error('CRM_INBOUND_URL or CRM_INBOUND_SECRET is not set; message not delivered to the CRM');
      return;
    }

    let raw = '';
    try {
      raw = await new Response(message.raw).text();
    } catch (error) {
      console.error('could not read raw message:', error?.message ?? error);
    }

    const headers = collectHeaders(message.headers);

    const payload = {
      from: headers.from || message.from,
      to: headers.to || message.to,
      subject: headers.subject || '',
      text: extractText(raw).slice(0, 100_000),
      headers,
    };

    const response = await fetch(env.CRM_INBOUND_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.CRM_INBOUND_SECRET}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      // Throwing asks Cloudflare to retry. The CRM de-duplicates on Message-ID,
      // so a retry after a partial success is harmless.
      throw new Error(`CRM rejected the message: ${response.status} ${detail.slice(0, 300)}`);
    }
  },
};
