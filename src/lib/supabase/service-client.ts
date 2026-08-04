import { createClient as createSupabaseClient } from '@supabase/supabase-js';

import { getServiceRoleKey, getSupabaseUrl } from '@/lib/env';
import type { Database } from './database.types';

/**
 * Service-role client factory. BYPASSES ROW LEVEL SECURITY.
 *
 * Deliberately free of the `server-only` marker so the CLI scripts under
 * scripts/ can use it under plain Node. Application code should import
 * `./admin` instead, which adds that guard.
 */
export function createServiceClient() {
  return createSupabaseClient<Database>(getSupabaseUrl(), getServiceRoleKey(), {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}

export type ServiceClient = ReturnType<typeof createServiceClient>;
