import { createClient } from '@/lib/supabase/server';
import type { InboundInboxRow } from '@/lib/supabase/database.types';

/**
 * The Replies inbox.
 *
 * Read through the RLS-bound server client, not the service-role client. The
 * page has already called requireAdmin(); going through RLS means a mistake in
 * a guard cannot turn this into an open feed of inbound mail.
 */

export interface InboxData {
  unmatched: InboundInboxRow[];
  matched: InboundInboxRow[];
  bounces: InboundInboxRow[];
  autoReplies: InboundInboxRow[];
  counts: {
    unmatched: number;
    needsReview: number;
    bounces: number;
    autoReplies: number;
    total: number;
  };
  error: string | null;
}

export async function getInbox(limit = 50): Promise<InboxData> {
  const supabase = await createClient();

  const countOf = async (build: PromiseLike<{ count: number | null }>) => (await build).count ?? 0;

  const [unmatched, matched, bounces, autoReplies, totalCount, unmatchedCount, reviewCount, bounceCount, autoCount] =
    await Promise.all([
      supabase
        .from('inbound_inbox')
        .select('*')
        .eq('match_status', 'unmatched')
        .in('kind', ['reply', 'other'])
        .order('received_at', { ascending: false })
        .limit(limit),
      supabase
        .from('inbound_inbox')
        .select('*')
        .eq('match_status', 'matched')
        .eq('kind', 'reply')
        .order('received_at', { ascending: false })
        .limit(limit),
      supabase
        .from('inbound_inbox')
        .select('*')
        .eq('kind', 'bounce')
        .order('received_at', { ascending: false })
        .limit(20),
      supabase
        .from('inbound_inbox')
        .select('*')
        .eq('kind', 'auto_reply')
        .order('received_at', { ascending: false })
        .limit(20),
      countOf(supabase.from('inbound_messages').select('*', { count: 'exact', head: true })),
      countOf(
        supabase
          .from('inbound_messages')
          .select('*', { count: 'exact', head: true })
          .eq('match_status', 'unmatched')
          .in('kind', ['reply', 'other']),
      ),
      countOf(
        supabase
          .from('inbound_messages')
          .select('*', { count: 'exact', head: true })
          .eq('kind', 'reply')
          .eq('is_handled', false),
      ),
      countOf(
        supabase.from('inbound_messages').select('*', { count: 'exact', head: true }).eq('kind', 'bounce'),
      ),
      countOf(
        supabase
          .from('inbound_messages')
          .select('*', { count: 'exact', head: true })
          .eq('kind', 'auto_reply'),
      ),
    ]);

  return {
    unmatched: unmatched.data ?? [],
    matched: matched.data ?? [],
    bounces: bounces.data ?? [],
    autoReplies: autoReplies.data ?? [],
    counts: {
      unmatched: unmatchedCount,
      needsReview: reviewCount,
      bounces: bounceCount,
      autoReplies: autoCount,
      total: totalCount,
    },
    error: unmatched.error?.message ?? matched.error?.message ?? null,
  };
}

export interface LeadOption {
  id: string;
  business_name: string;
  email: string | null;
  city: string | null;
  country: string | null;
}

/**
 * Lead lookup for the assignment picker.
 *
 * A select element with 698 options is unusable, so the picker searches. The
 * `.or()` filter takes user input, hence the same sanitisation the leads list
 * uses: commas and parentheses would otherwise break out of the PostgREST
 * filter expression.
 */
export async function searchLeadsForPicker(term: string, limit = 12): Promise<LeadOption[]> {
  const cleaned = term
    .trim()
    .replace(/[,()\\]/g, ' ')
    .replace(/[%_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length < 2) return [];

  const supabase = await createClient();
  const { data } = await supabase
    .from('leads')
    .select('id, business_name, email, city, country')
    .or(`business_name.ilike.*${cleaned}*,email.ilike.*${cleaned}*,website.ilike.*${cleaned}*`)
    .order('business_name', { ascending: true })
    .limit(limit);

  return data ?? [];
}
