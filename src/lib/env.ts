/**
 * Environment access.
 *
 * Values are read lazily rather than validated at module load: a missing
 * variable should fail the request that needs it with a clear message, not
 * crash `next build` on a machine that has no credentials configured.
 *
 * The `process.env.NEXT_PUBLIC_*` reads are written out literally because Next
 * inlines them at build time by textual substitution destructuring or dynamic
 * indexing would break that.
 */

function required(name: string, value: string | undefined): string {
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing environment variable ${name}. Copy .env.example to .env.local and fill it in.`,
    );
  }
  return value;
}

/** Supabase project URL. Safe in the browser. */
export function getSupabaseUrl(): string {
  return required('NEXT_PUBLIC_SUPABASE_URL', process.env.NEXT_PUBLIC_SUPABASE_URL);
}

/** Anon key. Safe in the browser every request is still subject to RLS. */
export function getSupabaseAnonKey(): string {
  return required('NEXT_PUBLIC_SUPABASE_ANON_KEY', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

/**
 * Service role key bypasses RLS.
 *
 * Server-side only. The guard below is a tripwire: if this module is ever
 * pulled into a client bundle the build-time replacement of `window` makes the
 * check fail loudly instead of shipping the key to a browser.
 */
export function getServiceRoleKey(): string {
  if (typeof window !== 'undefined') {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY must never be read in the browser.');
  }
  return required('SUPABASE_SERVICE_ROLE_KEY', process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/**
 * Shared secret for the scheduled endpoints under /api/cron.
 *
 * Returns null rather than throwing when unset, so the route can answer 503
 * "not configured" instead of 500. Those routes send real email and are
 * reachable without a session, so a missing secret must disable them, never
 * open them.
 */
export function getCronSecret(): string | null {
  if (typeof window !== 'undefined') {
    throw new Error('CRON_SECRET must never be read in the browser.');
  }
  const value = process.env.CRON_SECRET;
  return value && value.trim() !== '' ? value : null;
}

/**
 * Shared secret for `/api/inbound`, which the Cloudflare Email Worker calls.
 *
 * Falls back to CRON_SECRET so there is one less thing to configure, but can be
 * set separately ,and should be, because this one lives in a Worker deployed
 * outside this repo. Rotating a leaked Worker secret should not also mean
 * reconfiguring the scheduler.
 *
 * Null when neither is set, and the route then answers 503. Fails closed.
 */
export function getInboundSecret(): string | null {
  if (typeof window !== 'undefined') {
    throw new Error('INBOUND_SECRET must never be read in the browser.');
  }
  const value = process.env.INBOUND_SECRET;
  if (value && value.trim() !== '') return value;
  return getCronSecret();
}
