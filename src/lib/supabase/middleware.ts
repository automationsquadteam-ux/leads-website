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
 * Refresh the Supabase session cookie and resolve the caller's role.
 *
 * The cookie dance matters: `getUser()` may rotate the refresh token, and those
 * new cookies have to be written onto the response that is actually returned.
 * Returning a different NextResponse silently signs users out mid-session.
 */
export async function readSession(request: NextRequest): Promise<SessionCheck> {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(getSupabaseUrl(), getSupabaseAnonKey(), {
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

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { response, userId: null, role: null };
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single<{ role: AppRole }>();

  return { response, userId: user.id, role: profile?.role ?? null };
}
