import {
  Archive, AlertTriangle, Ban, CheckCircle2, Clock, FileText,
  Inbox, MailCheck, Reply, Search, Send,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { Badge, type BadgeTone } from '@/components/ui/badge';
import type { EmailLogStatus, LeadStatus, ReplySentiment } from '@/lib/supabase/database.types';

/**
 * Status colours are paired with an icon and a text label, never colour alone —
 * the `color-not-only` accessibility rule.
 */
const LEAD_STATUS: Record<LeadStatus, { label: string; tone: BadgeTone; icon: LucideIcon }> = {
  new: { label: 'New', tone: 'neutral', icon: Inbox },
  researching: { label: 'Researching', tone: 'info', icon: Search },
  ready: { label: 'Ready', tone: 'violet', icon: FileText },
  approved: { label: 'Approved', tone: 'success', icon: CheckCircle2 },
  sending: { label: 'Sending', tone: 'warning', icon: Clock },
  sent: { label: 'Sent', tone: 'primary', icon: Send },
  replied: { label: 'Replied', tone: 'success', icon: Reply },
  bounced: { label: 'Bounced', tone: 'warning', icon: AlertTriangle },
  invalid: { label: 'Invalid', tone: 'danger', icon: Ban },
  archived: { label: 'Archived', tone: 'neutral', icon: Archive },
};

export function StatusBadge({ status }: { status: LeadStatus }) {
  const config = LEAD_STATUS[status] ?? LEAD_STATUS.new;
  const Icon = config.icon;
  return (
    <Badge tone={config.tone}>
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      {config.label}
    </Badge>
  );
}

export const LEAD_STATUS_LABELS = Object.fromEntries(
  Object.entries(LEAD_STATUS).map(([key, value]) => [key, value.label]),
) as Record<LeadStatus, string>;

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
