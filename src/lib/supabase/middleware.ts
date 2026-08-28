import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

import { getSupabaseAnonKey, getSupabaseUrl } from '@/lib/env';
import type { AppRole } from './database.types';

export interface SessionCheck {
  /** Response carrying any refreshed auth cookies. Must be the one returned. */
  response: NextResponse;
  userId: string | null;
  role: AppRole | null;
}

/**
 * How long any single Supabase call in the middleware may take.
 *
 * Vercel kills the whole middleware invocation at ~25s with a 504
 * MIDDLEWARE_INVOCATION_TIMEOUT, and that error page replaces the site for
 * EVERY route, public ones included ,which is exactly what happened on
 * 2026-08-28 when this project's GoTrue (auth) service stopped answering while
 * PostgREST stayed healthy. Measured then: `/auth/v1/health`, which needs no
 * credentials at all, hung past 12s on every attempt; `/rest/v1/` answered in
 * 117ms.
 *
 * Three seconds is far above a healthy auth round trip (tens of ms) and far
 * below the platform's limit, so a degraded auth service costs a visitor one
 * slow request instead of taking the site down.
 */
const AUTH_TIMEOUT_MS = 3_000;

/**
 * `fetch` with a hard deadline, injected into the Supabase client.
 *
 * The client has no timeout of its own ,it inherits whatever the platform
 * gives it, and on the edge that is effectively "until the invocation is
 * killed". An AbortController is the only way to bound it.
 */
function timeoutFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);
  return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

/**
 * Refresh the Supabase session cookie and resolve the caller's role.
 *
 * The cookie dance matters: `getUser()` may rotate the refresh token, and those
 * new cookies have to be written onto the response that is actually returned.
 * Returning a different NextResponse silently signs users out mid-session.
 *
 * FAILS CLOSED, NOT OPEN, and never throws. If auth cannot be reached this
 * returns `userId: null`, which the caller treats as "signed out": a protected
 * route redirects to /login rather than 504-ing, and nothing is authorised on
 * the strength of an unanswered question. The cost of that choice is that a
 * genuine outage signs everyone out for its duration ,which is the right way
 * round, and the page guards plus RLS still stand behind it either way.
 */
export async function readSession(request: NextRequest): Promise<SessionCheck> {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(getSupabaseUrl(), getSupabaseAnonKey(), {
    global: { fetch: timeoutFetch },
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  let user: { id: string } | null = null;
  try {
    const result = await supabase.auth.getUser();
    user = result.data.user;
  } catch (cause) {
    // An aborted fetch lands here. Treated as "signed out" ,see the note on
    // failing closed above.
    console.error('[middleware] auth unreachable, treating request as signed out:', cause);
    return { response, userId: null, role: null };
  }

  if (!user) {
    return { response, userId: null, role: null };
  }

  try {
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single<{ role: AppRole }>();

    return { response, userId: user.id, role: profile?.role ?? null };
  } catch (cause) {
    // The user is known but their role is not. `null` role authorises nothing,
    // so this degrades to /unauthorized rather than to admin access.
    console.error('[middleware] profile lookup failed:', cause);
    return { response, userId: user.id, role: null };
  }
}
