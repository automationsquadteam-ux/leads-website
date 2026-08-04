import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

import { getSupabaseAnonKey, getSupabaseUrl } from '@/lib/env';
import type { Database } from './database.types';

/**
 * Supabase client for Server Components, Route Handlers and Server Actions.
 *
 * Requests made with it carry the caller's session, so RLS applies — a viewer
 * asking for leads gets an empty result, not a leak.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(getSupabaseUrl(), getSupabaseAnonKey(), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components cannot set cookies. Safe to ignore: the
          // middleware refreshes the session cookie on every matched request.
        }
      },
    },
  });
}
