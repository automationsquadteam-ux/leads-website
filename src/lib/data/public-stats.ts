import { createClient as createSupabaseClient } from '@supabase/supabase-js';

import { getSupabaseAnonKey, getSupabaseUrl } from '@/lib/env';
import type { Database, Views } from '@/lib/supabase/database.types';

/**
 * Data for the login-free statistics page.
 *
 * Read with a **plain anon client**, not the service-role client and not the
 * cookie-bound SSR client. That is a deliberate security choice, and the reason
 * matters:
 *
 *   * The service-role key bypasses RLS entirely. Using it on a page anyone can
 *     load would mean one mistyped table name is a data breach. With the anon
 *     key, the database itself refuses: the only objects granted to `anon` are
 *     the five public_stats_* views from migration 0013, so a bad query here
 *     returns an error, never a lead.
 *   * The SSR client would attach whatever session cookie the visitor happens
 *     to have, making an admin's view of this page silently different from an
 *     anonymous visitor's. A public page should render the same thing for
 *     everyone that is what makes it reviewable.
 *
 * The upshot: this module is incapable of leaking lead data, and that property
 * is enforced by Postgres grants rather than by care.
 */

function createAnonClient() {
  return createSupabaseClient<Database>(getSupabaseUrl(), getSupabaseAnonKey(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export interface PublicStats {
  overview: Views<'public_stats_overview'> | null;
  stages: Views<'public_stats_stages'>[];
  activity: Views<'public_stats_activity_daily'>[];
  /**
   * Opt-in lead list. Empty unless an admin switched it on AND chose which
   * stages may appear the view enforces both, so an empty array here is the
   * correct and expected default.
   */
  leads: Views<'public_stats_leads'>[];
  error: string | null;
}

export async function getPublicStats(): Promise<PublicStats> {
  const supabase = createAnonClient();

  const [overview, stages, activity, leads] = await Promise.all([
    supabase.from('public_stats_overview').select('*').maybeSingle(),
    supabase.from('public_stats_stages').select('*'),
    supabase.from('public_stats_activity_daily').select('*').order('day', { ascending: true }),
    supabase.from('public_stats_leads').select('*'),
  ]);

  return {
    overview: overview.data ?? null,
    stages: stages.data ?? [],
    activity: activity.data ?? [],
    leads: leads.data ?? [],
    error: overview.error?.message ?? null,
  };
}
