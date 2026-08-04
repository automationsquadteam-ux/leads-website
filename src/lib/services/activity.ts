import 'server-only';

import { createServiceClient } from '@/lib/supabase/service-client';
import type { ActivityKind, LeadActivity } from '@/lib/supabase/database.types';

/**
 * The activity feed.
 *
 * Written with the service-role client because every caller has already passed
 * assertAdmin(), and because an audit line must survive a session expiring
 * mid-request — losing the record of a change is worse than the change itself.
 *
 * Recording is always best-effort: a failure here never fails the action that
 * prompted it. An admin whose approval is rejected because the audit table was
 * briefly unavailable would, reasonably, just click again.
 */

export interface ActivityInput {
  leadId: string;
  kind: ActivityKind;
  summary: string;
  detail?: string | null;
  actorId?: string | null;
}

export async function recordActivity(input: ActivityInput): Promise<void> {
  const admin = createServiceClient();
  await admin.from('lead_activity').insert({
    lead_id: input.leadId,
    kind: input.kind,
    summary: input.summary.slice(0, 500),
    // Detail can hold a draft excerpt; cap it so the feed stays queryable.
    detail: input.detail ? input.detail.slice(0, 4000) : null,
    actor_id: input.actorId ?? null,
  });
}

export async function getLeadActivity(leadId: string, limit = 30): Promise<LeadActivity[]> {
  const admin = createServiceClient();
  const { data } = await admin
    .from('lead_activity')
    .select('*')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false })
    .limit(limit);
  return data ?? [];
}
