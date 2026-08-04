import { createBrowserClient } from '@supabase/ssr';

import { getSupabaseAnonKey, getSupabaseUrl } from '@/lib/env';
import type { Database } from './database.types';

/**
 * Supabase client for Client Components.
 *
 * Call this inside an event handler or effect, not at module scope, so that
 * prerendering never needs the env vars.
 */
export function createClient() {
  return createBrowserClient<Database>(getSupabaseUrl(), getSupabaseAnonKey());
}
