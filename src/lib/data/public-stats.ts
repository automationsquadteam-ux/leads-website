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

/**
 * How long the public page will wait for Supabase before giving up.
 *
 * This page is `force-dynamic`, so every visitor waits on these queries with
 * nothing on screen until they answer. Without a bound that wait is the
 * platform's request timeout ,measured on 2026-08-28, while this project's
 * Supabase was degraded, the front page intermittently hung past 30s and
 * returned nothing at all, when the honest answer ("statistics are unavailable
 * right now") was already a supported state of this function.
 *
 * Eight seconds is well past a healthy read here (~300ms measured) and short
 * enough that a visitor gets a rendered page rather than a spinner that never
 * resolves.
 */
const QUERY_TIMEOUT_MS = 8_000;

function timeoutFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS);
  return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function createAnonClient() {
  return createSupabaseClient<Database>(getSupabaseUrl(), getSupabaseAnonKey(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: timeoutFetch },
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

  /*
   * A timed-out fetch REJECTS rather than resolving with an `error` field, so
   * this needs a catch as well as the per-query error check below. Without it
   * an abort propagates out of the render and the visitor gets a 500 instead
   * of the page ,which defeats the point of bounding the wait at all.
   *
   * Every field degrades to its empty value and `error` carries the reason,
   * which the page already renders as a notice above the (empty) figures.
   */
  try {
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
  } catch (cause) {
    const message =
      cause instanceof Error && cause.name === 'AbortError'
        ? `The database did not respond within ${QUERY_TIMEOUT_MS / 1000}s.`
        : cause instanceof Error
          ? cause.message
          : 'The database could not be reached.';
    console.error('[public-stats] read failed:', cause);
    return { overview: null, stages: [], activity: [], leads: [], error: message };
  }
}
