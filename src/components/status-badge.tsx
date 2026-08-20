import { AlertTriangle, Ban, CheckCircle2, Clock, MailCheck, Send } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { Badge, type BadgeTone } from '@/components/ui/badge';
import type { EmailLogStatus, ReplySentiment } from '@/lib/supabase/database.types';

/**
 * Status colours are paired with an icon and a text label, never colour alone —
 * the `color-not-only` accessibility rule.
 */
/*
 * StatusBadge, LEAD_STATUS and LEAD_STATUS_LABELS used to live here.
 *
 * They rendered `leads.status`, which since migration 0025 is an inbound label
 * from the Google Sheet rather than a description of where a lead stands - it
 * read "Researching" on 472 leads while 695 of them had research complete. The
 * pipeline STAGE says what is actually true, is derived in Postgres, and has its
 * own badge in components/pipeline-badge.tsx. Nothing renders lead status now.
 *
 * The badges below are unrelated: they describe an individual EMAIL and an
 * individual REPLY, both of which are facts rather than labels.
 */

const EMAIL_STATUS: Record<EmailLogStatus, { label: string; tone: BadgeTone; icon: LucideIcon }> = {
  queued: { label: 'Queued', tone: 'neutral', icon: Clock },
  sent: { label: 'Sent', tone: 'primary', icon: Send },
  delivered: { label: 'Delivered', tone: 'success', icon: MailCheck },
  opened: { label: 'Opened', tone: 'success', icon: CheckCircle2 },
  clicked: { label: 'Clicked', tone: 'success', icon: CheckCircle2 },
  bounced: { label: 'Bounced', tone: 'warning', icon: AlertTriangle },
  complained: { label: 'Complained', tone: 'danger', icon: AlertTriangle },
  failed: { label: 'Failed', tone: 'danger', icon: Ban },
};

export function EmailStatusBadge({ status }: { status: EmailLogStatus }) {
  const config = EMAIL_STATUS[status] ?? EMAIL_STATUS.queued;
  const Icon = config.icon;
  return (
    <Badge tone={config.tone}>
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      {config.label}
    </Badge>
  );
}

/**
 * Labels for `email_logs.failure_reason` (0040). Keyed loosely by string,
 * not by the `SendFailureReason` union in send-lead-email.ts ,that module is
 * `server-only` and this file renders in the browser, so importing even a
 * type from it is worth avoiding. An unrecognised or null reason (any row
 * logged before this column existed) falls back to the raw value.
 */
const FAILURE_REASON: Record<string, { label: string; tone: BadgeTone }> = {
  archived: { label: 'Lead archived', tone: 'neutral' },
  no_email: { label: 'No email address', tone: 'warning' },
  email_invalid: { label: 'Address proved invalid', tone: 'danger' },
  verifier_invalid: { label: 'Verifier says invalid', tone: 'danger' },
  unverified: { label: 'Not verified', tone: 'warning' },
  no_draft: { label: 'No draft', tone: 'warning' },
  no_subject: { label: 'No subject line', tone: 'warning' },
  provider_config: { label: 'Provider misconfigured', tone: 'danger' },
  unresolved_placeholder: { label: 'Unresolved placeholder', tone: 'danger' },
  send_rejected: { label: 'Rejected by provider', tone: 'danger' },
};

export function failureReasonLabel(reason: string | null): string {
  if (!reason) return 'Unknown (logged before this was tracked)';
  return FAILURE_REASON[reason]?.label ?? reason;
}

export function FailureReasonBadge({ reason }: { reason: string | null }) {
  const config = reason ? FAILURE_REASON[reason] : undefined;
  return <Badge tone={config?.tone ?? 'neutral'}>{failureReasonLabel(reason)}</Badge>;
}

const SENTIMENT: Record<ReplySentiment, { label: string; tone: BadgeTone }> = {
  positive: { label: 'Positive', tone: 'success' },
  neutral: { label: 'Neutral', tone: 'neutral' },
  negative: { label: 'Negative', tone: 'danger' },
  unsubscribe: { label: 'Unsubscribe', tone: 'warning' },
  auto_reply: { label: 'Auto-reply', tone: 'info' },
};

export function SentimentBadge({ sentiment }: { sentiment: ReplySentiment | null }) {
  if (!sentiment) return <Badge tone="neutral">Unclassified</Badge>;
  const config = SENTIMENT[sentiment];
  return <Badge tone={config.tone}>{config.label}</Badge>;
}
