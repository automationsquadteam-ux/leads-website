import 'server-only';

import { createServiceClient } from '@/lib/supabase/service-client';
import type {
  LeadPipeline,
  LeadPipelineUpdate,
  PipelineBoardRow,
} from '@/lib/supabase/database.types';

/**
 * Pipeline reads and writes.
 *
 * What this file does NOT do, deliberately:
 *
 *   * decide a stage public.compute_pipeline_stage() does, in a BEFORE
 *     trigger, on every write;
 *   * decide a next step public.compute_next_step() does, and the
 *     pipeline_board view exposes it;
 *   * advance the sequence after a send the email_logs trigger does.
 *
 * Everything here is either "read what the database decided" or "record a fact
 * a human asserted" (verified this address, marked this stage complete, closed
 * this workflow). Keeping the derivations in one place, in SQL, is what stops
 * the board and the scheduled sender drifting apart.
 */

export async function ensurePipeline(leadId: string): Promise<void> {
  const admin = createServiceClient();
  // The leads trigger creates this row, so it exists for every lead. This
  // covers rows written before migration 0012 by any path that skipped it.
  await admin.from('lead_pipeline').upsert({ lead_id: leadId }, { onConflict: 'lead_id' });
}

export async function getPipeline(leadId: string): Promise<LeadPipeline | null> {
  const admin = createServiceClient();
  const { data } = await admin.from('lead_pipeline').select('*').eq('lead_id', leadId).maybeSingle();
  return data ?? null;
}

/** The row plus its derived next_step, which only the view can supply. */
export async function getPipelineBoardRow(leadId: string): Promise<PipelineBoardRow | null> {
  const admin = createServiceClient();
  const { data } = await admin.from('pipeline_board').select('*').eq('lead_id', leadId).maybeSingle();
  return data ?? null;
}

/**
 * Record an operator assertion.
 *
 * `current_stage` is intentionally not accepted: it is derived, and letting a
 * caller pass it would create a second, silently-losing source of truth.
 */
export async function updatePipeline(
  leadId: string,
  patch: Omit<LeadPipelineUpdate, 'lead_id'>,
): Promise<{ ok: boolean; message: string; pipeline: LeadPipeline | null }> {
  const admin = createServiceClient();

  await ensurePipeline(leadId);

  const { data, error } = await admin
    .from('lead_pipeline')
    .update(patch)
    .eq('lead_id', leadId)
    .select('*')
    .single();

  if (error || !data) {
    return { ok: false, message: error?.message ?? 'Could not update the pipeline.', pipeline: null };
  }
  return { ok: true, message: 'Pipeline updated.', pipeline: data };
}

export async function closeWorkflow(
  leadId: string,
  reason: string,
): Promise<{ ok: boolean; message: string }> {
  const result = await updatePipeline(leadId, {
    closed: new Date().toISOString(),
    closed_reason: reason.slice(0, 300),
  });
  return { ok: result.ok, message: result.ok ? 'Workflow closed.' : result.message };
}

export async function reopenWorkflow(leadId: string): Promise<{ ok: boolean; message: string }> {
  const result = await updatePipeline(leadId, { closed: null, closed_reason: null });
  return { ok: result.ok, message: result.ok ? 'Workflow reopened.' : result.message };
}

/**
 * Clearing a gate flag also clears its timestamp.
 *
 * Without this, un-approving and re-approving would keep the original
 * approved_at (the stamping trigger only fills a NULL), and "average approval
 * time" would quietly measure the wrong interval.
 */
export function gateFlagPatch(
  flag: 'email_verified' | 'research_complete' | 'draft_ready' | 'approved',
  value: boolean,
): Omit<LeadPipelineUpdate, 'lead_id'> {
  const stampColumn = {
    email_verified: 'email_verified_at',
    research_complete: 'research_completed_at',
    draft_ready: 'draft_ready_at',
    approved: 'approved_at',
  } as const;

  return value
    ? { [flag]: true }
    : { [flag]: false, [stampColumn[flag]]: null };
}
