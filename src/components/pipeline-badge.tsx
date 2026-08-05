import {
  ArrowRight, Ban, CheckCircle2, Clock, FileText, Mail, MailCheck, MailX, PenLine,
  Search, Send, ShieldCheck, Reply as ReplyIcon, Archive,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { NEXT_STEP_META, STAGE_META } from '@/lib/pipeline/labels';
import { cn, formatRelative } from '@/lib/utils';
import type { PipelineNextStep, PipelineStage } from '@/lib/supabase/database.types';

/**
 * Stage and Next Step, shown the same way everywhere.
 *
 * Colour is never the only signal every badge pairs a tone with an icon and a
 * text label, matching the rest of the app's status components.
 */

const STAGE_ICONS: Record<PipelineStage, LucideIcon> = {
  need_email: Mail,
  dead_email: MailX,
  need_verification: ShieldCheck,
  research: Search,
  draft: PenLine,
  review: FileText,
  approved: CheckCircle2,
  initial_sent: Send,
  followup1_sent: MailCheck,
  followup2_sent: MailCheck,
  replied: ReplyIcon,
  closed: Archive,
};

const NEXT_STEP_ICONS: Record<PipelineNextStep, LucideIcon> = {
  need_email: Mail,
  need_verification: ShieldCheck,
  research_lead: Search,
  generate_draft: PenLine,
  approve_draft: FileText,
  send_initial_email: Send,
  await_followup1: Clock,
  send_followup1: Send,
  await_followup2: Clock,
  send_followup2: Send,
  close_workflow: CheckCircle2,
  complete: Ban,
};

export function StageBadge({ stage }: { stage: PipelineStage }) {
  const meta = STAGE_META[stage];
  const Icon = STAGE_ICONS[stage];
  return (
    <Badge tone={meta.tone} title={meta.description}>
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      {meta.label}
    </Badge>
  );
}

export function NextStepBadge({ step }: { step: PipelineNextStep }) {
  const meta = NEXT_STEP_META[step];
  const Icon = NEXT_STEP_ICONS[step];
  return (
    <Badge tone={meta.tone} title={meta.hint}>
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      {meta.label}
    </Badge>
  );
}

/**
 * The prominent stage + next step display for a lead page.
 *
 * Reads as a sentence "Draft Ready → Approve Draft" because the pair only
 * means something together: the stage says where the lead is, the next step
 * says what to do about it.
 */
export function PipelineTracker({
  stage,
  nextStep,
  due,
  className,
}: {
  stage: PipelineStage;
  nextStep: PipelineNextStep;
  /** When the next step becomes actionable, for the waiting states. */
  due?: string | null;
  className?: string;
}) {
  const stageMeta = STAGE_META[stage];
  const stepMeta = NEXT_STEP_META[nextStep];
  const waiting = nextStep === 'await_followup1' || nextStep === 'await_followup2';

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-surface px-3 py-2.5',
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">Stage</span>
        <StageBadge stage={stage} />
      </div>

      <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />

      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">Next step</span>
        <NextStepBadge step={nextStep} />
      </div>

      <p className="w-full text-xs text-muted-foreground sm:w-auto sm:flex-1">
        {stepMeta.hint}
        {waiting && due ? ` Due ${formatRelative(due)}.` : null}
      </p>

      <span className="sr-only">
        {stageMeta.label}. Next step: {stepMeta.label}. {stepMeta.hint}
      </span>
    </div>
  );
}
