import type { EmailType, Lead, LeadPipeline } from '@/lib/supabase/database.types';

/**
 * The outbound-sync contract.
 *
 * Every admin change that must leave the CRM goes through one call —
 * `syncLeadChange()` — and fans out to whatever targets are registered and
 * enabled. Today that is the Google Sheet. Adding a webhook, a CRM push or an
 * n8n-facing API later is a new file implementing `SyncTarget` plus one entry
 * in the registry: no caller changes, no second place that decides "did
 * anything change worth pushing".
 */

/** The fields a change can touch. Targets map these onto their own shape. */
export type SyncField =
  | 'research'
  | 'personalization'
  | 'draft'
  | 'followup1'
  | 'followup2'
  | 'status'
  | 'stage'
  | 'notes'
  | 'identity';

export const ALL_SYNC_FIELDS: readonly SyncField[] = [
  'research',
  'personalization',
  'draft',
  'followup1',
  'followup2',
  'status',
  'stage',
  'notes',
  'identity',
] as const;

/**
 * Everything a target could need, resolved once by the dispatcher.
 *
 * Passing a snapshot rather than a lead id means N targets cost one set of
 * queries, not N.
 */
export interface SyncSnapshot {
  lead: Lead;
  pipeline: LeadPipeline | null;
  /** Derived next step, from pipeline_board. Null when the row is missing. */
  nextStep: string | null;
  /** Active draft per step — what a reader of the sheet should actually see. */
  activeDrafts: Partial<Record<EmailType, { subject: string | null; content: string }>>;
}

export interface SyncOutcome {
  target: string;
  /** False when the target is switched off or has nothing to write for this lead. */
  attempted: boolean;
  ok: boolean;
  message: string;
}

export interface SyncTarget {
  id: string;
  label: string;
  /** Checked before every dispatch, so toggling a setting takes effect at once. */
  isEnabled(): Promise<boolean>;
  push(snapshot: SyncSnapshot, fields: SyncField[]): Promise<SyncOutcome>;
}

export interface SyncReport {
  outcomes: SyncOutcome[];
  /** True when at least one target tried and failed — surfaced in the toast. */
  hasFailure: boolean;
  /** Single-line summary suitable for appending to an action's message. */
  summary: string | null;
}
