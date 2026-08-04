import type { BadgeTone } from '@/components/ui/badge';
import type {
  EmailType,
  EmailVerificationStatus,
  PipelineNextStep,
  PipelineStage,
} from '@/lib/supabase/database.types';

/**
 * Presentation for the pipeline enums and ONLY presentation.
 *
 * The rules that decide a stage or a next step live in Postgres
 * (public.compute_pipeline_stage / public.compute_next_step). If you find
 * yourself writing an `if` here that picks a stage, it belongs in the migration
 * instead: two implementations of the same rule is how the board and the
 * scheduled sender start disagreeing about what a lead needs.
 */

export interface StageMeta {
  label: string;
  /** One line explaining what this stage means, for tooltips and empty states. */
  description: string;
  tone: BadgeTone;
}

export const STAGE_META: Record<PipelineStage, StageMeta> = {
  need_email: {
    label: 'Need Email',
    description: 'No contact address on file yet.',
    tone: 'danger',
  },
  need_verification: {
    label: 'Need Verification',
    description: 'An address exists but has not been confirmed deliverable.',
    tone: 'warning',
  },
  research: {
    label: 'Researching',
    description: 'Address verified. Research has not been written.',
    tone: 'info',
  },
  draft: {
    label: 'Needs Draft',
    description: 'Research is done. No email has been drafted.',
    tone: 'info',
  },
  review: {
    label: 'Draft Ready',
    description: 'A draft exists and is waiting for a human to approve it.',
    tone: 'violet',
  },
  approved: {
    label: 'Approved',
    description: 'Signed off and ready to send.',
    tone: 'success',
  },
  initial_sent: {
    label: 'Initial Sent',
    description: 'The first email has gone out.',
    tone: 'primary',
  },
  followup1_sent: {
    label: 'Follow-up 1 Sent',
    description: 'The first follow-up has gone out.',
    tone: 'primary',
  },
  followup2_sent: {
    label: 'Follow-up 2 Sent',
    description: 'The sequence is complete.',
    tone: 'primary',
  },
  replied: {
    label: 'Replied',
    description: 'The prospect responded. Sending has stopped.',
    tone: 'success',
  },
  closed: {
    label: 'Closed',
    description: 'The workflow has been closed out.',
    tone: 'neutral',
  },
};

export interface NextStepMeta {
  label: string;
  /** What the operator should actually do. Shown under the label. */
  hint: string;
  tone: BadgeTone;
  /** True when the system can perform this itself, given the right settings. */
  automatable: boolean;
}

export const NEXT_STEP_META: Record<PipelineNextStep, NextStepMeta> = {
  need_email: {
    label: 'Need Email',
    hint: 'Find a contact address before anything else can happen.',
    tone: 'danger',
    automatable: false,
  },
  need_verification: {
    label: 'Need Verification',
    hint: 'Confirm the address is deliverable, then mark it verified.',
    tone: 'warning',
    automatable: false,
  },
  research_lead: {
    label: 'Research Lead',
    hint: 'Write the research summary for this business.',
    tone: 'info',
    automatable: false,
  },
  generate_draft: {
    label: 'Generate Draft',
    hint: 'Produce the initial email from the research and personalization.',
    tone: 'info',
    automatable: false,
  },
  approve_draft: {
    label: 'Approve Draft',
    hint: 'Read the draft and approve or reject it.',
    tone: 'violet',
    automatable: false,
  },
  send_initial_email: {
    label: 'Send Initial Email',
    hint: 'Approved and waiting to go out.',
    tone: 'success',
    automatable: true,
  },
  await_followup1: {
    label: 'Awaiting Follow-up 1',
    hint: 'Sent. Follow-up 1 is scheduled and not due yet.',
    tone: 'neutral',
    automatable: true,
  },
  send_followup1: {
    label: 'Send Follow-up 1',
    hint: 'Follow-up 1 is due now.',
    tone: 'primary',
    automatable: true,
  },
  await_followup2: {
    label: 'Awaiting Follow-up 2',
    hint: 'Follow-up 1 sent. Follow-up 2 is scheduled and not due yet.',
    tone: 'neutral',
    automatable: true,
  },
  send_followup2: {
    label: 'Send Follow-up 2',
    hint: 'Follow-up 2 is due now.',
    tone: 'primary',
    automatable: true,
  },
  close_workflow: {
    label: 'Close Workflow',
    hint: 'The prospect replied or the sequence is exhausted. Close it out.',
    tone: 'success',
    automatable: false,
  },
  complete: {
    label: 'Complete',
    hint: 'Nothing left to do.',
    tone: 'neutral',
    automatable: false,
  },
};

export const VERIFICATION_META: Record<
  EmailVerificationStatus,
  { label: string; hint: string; tone: BadgeTone }
> = {
  unverified: {
    label: 'Unverified',
    hint: 'Never checked. Export it and run it through a verifier.',
    tone: 'neutral',
  },
  valid: {
    label: 'Verified',
    hint: 'Deliverable. Either a verifier confirmed it or a real email was accepted.',
    tone: 'success',
  },
  accept_all: {
    label: 'Catch-all',
    hint: 'The domain accepts every address, so the check proved nothing either way.',
    tone: 'warning',
  },
  unknown: {
    label: 'Unknown',
    hint: 'The verifier could not decide. Worth re-running.',
    tone: 'warning',
  },
  invalid: {
    label: 'Dead',
    hint: 'Proved undeliverable. This lead needs a new address.',
    tone: 'danger',
  },
};

export const EMAIL_TYPE_LABELS: Record<EmailType, string> = {
  initial: 'Initial Email',
  followup1: 'Follow-up 1',
  followup2: 'Follow-up 2',
};

export const EMAIL_TYPE_SHORT: Record<EmailType, string> = {
  initial: 'Initial',
  followup1: 'F/U 1',
  followup2: 'F/U 2',
};
