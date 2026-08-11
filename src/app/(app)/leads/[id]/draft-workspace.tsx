'use client';

import * as React from 'react';
import { useActionState } from 'react';
import {
  AlertTriangle, CheckCircle2, Clock, History, RefreshCw, Save, Send, Sparkles, XCircle,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Field, Input, Textarea } from '@/components/ui/input';
import { EmptyState } from '@/components/empty-state';
import {
  EMPTY_ACTION_RESULT,
  PanelError,
  useActionFeedback,
  useAsyncAction,
} from '@/components/action-form';
import {
  activateVersion,
  approveVersion,
  regenerateDraft,
  rejectVersion,
  saveDraft,
} from '@/lib/actions/review';
import { sendEmail } from '@/lib/actions/leads';
import { EMAIL_TYPE_LABELS } from '@/lib/pipeline/labels';
import { inspectDraft } from '@/lib/services/drafts/quality';
import { cn, formatDateTime, formatRelative } from '@/lib/utils';
import { EMAIL_TYPES, type EmailType, type EmailVersion } from '@/lib/supabase/database.types';

/**
 * The draft review workspace.
 *
 * One tab per step of the sequence, each with the active draft and its full
 * version history. The rules this UI has to make visible:
 *
 *   * Saving an edit CREATES a version. It does not overwrite the one on
 *     screen the button says "Save as new version" for that reason.
 *   * Regenerating creates a version too, and the previous one stays one click
 *     away in the history below.
 *   * Exactly one version per step is active. That is the one shown by default
 *     and the one the sender uses.
 *   * Rejecting keeps the row. A rejected draft is often the most useful thing
 *     in the history.
 */

interface Props {
  leadId: string;
  versions: EmailVersion[];
  /** Send buttons are pointless without an address; say so rather than fail. */
  hasEmail: boolean;
  /** Which steps have already gone out, so a second send is not offered. */
  sentTypes: EmailType[];
}

export function DraftWorkspace({ leadId, versions, hasEmail, sentTypes }: Props) {
  const [tab, setTab] = React.useState<EmailType>('initial');

  const byType = React.useMemo(() => {
    const grouped: Record<EmailType, EmailVersion[]> = { initial: [], followup1: [], followup2: [] };
    for (const version of versions) grouped[version.type].push(version);
    for (const key of EMAIL_TYPES) {
      grouped[key].sort((a, b) => b.version_number - a.version_number);
    }
    return grouped;
  }, [versions]);

  return (
    <Card>
      <CardHeader className="flex-col items-stretch gap-3 sm:flex-row sm:items-center">
        <div>
          <CardTitle>Email drafts</CardTitle>
          <CardDescription>
            Every save and every regeneration creates a new version. Nothing is overwritten.
          </CardDescription>
        </div>
      </CardHeader>

      {/* Tablist: arrow keys are not intercepted, so this stays a plain,
          predictable set of buttons rather than a half-implemented widget.

          `overflow-x-auto` because the three tabs total roughly 400px once each
          carries its version chip and sent icon — wider than a 386px phone. In a
          plain `flex` they overflowed the card, and the shell clips horizontally
          rather than scrolling, so "Follow-up 2" was simply unreachable. Tabs
          scroll rather than wrap: a wrapped tab strip moves the row the content
          is attached to, which is worse than a short sideways swipe. */}
      <div
        role="tablist"
        aria-label="Email steps"
        className="scrollbar-thin flex gap-1 overflow-x-auto overscroll-x-contain border-b border-border px-4"
      >
        {EMAIL_TYPES.map((type) => {
          const active = byType[type].find((v) => v.active);
          const selected = tab === type;
          return (
            <button
              key={type}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setTab(type)}
              className={cn(
                'relative -mb-px shrink-0 cursor-pointer border-b-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap transition-colors',
                selected
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              <span className="flex items-center gap-1.5">
                {EMAIL_TYPE_LABELS[type]}
                {byType[type].length > 0 ? (
                  <span className="tabular rounded bg-muted px-1 text-[10px] text-muted-foreground">
                    v{active?.version_number ?? byType[type][0]!.version_number}
                  </span>
                ) : null}
                {sentTypes.includes(type) ? (
                  <Send className="size-3 text-primary" aria-label="Sent" />
                ) : null}
              </span>
            </button>
          );
        })}
      </div>

      <CardContent className="space-y-4">
        <DraftEditor
          key={tab}
          leadId={leadId}
          type={tab}
          versions={byType[tab]}
          hasEmail={hasEmail}
          alreadySent={sentTypes.includes(tab)}
        />
      </CardContent>
    </Card>
  );
}

/**
 * Placeholder text that would be mailed literally.
 *
 * The real block lives in the send path, which is what protects the cron sender
 * too. This is the same check surfaced early, so the problem is visible while
 * the draft is on screen and editable rather than as a refusal after clicking
 * Send.
 *
 * The check runs against the raw draft, not the rendered one, so `{{signature}}`
 * and friends do show up here. That is the right trade: over-reporting in a
 * warning costs a glance, under-reporting costs a prospect.
 */
/** Blocking issues, used to disable Send and explain why. */
function useBlockingIssues(subject: string | null, content: string) {
  return React.useMemo(
    () => inspectDraft({ subject, content }).filter((issue) => issue.blocking),
    [subject, content],
  );
}

/**
 * Everything wrong with the draft on screen.
 *
 * Runs the same checks as the bulk sweep, so "why was this one left behind"
 * is answered right here instead of being a mystery. Blocking issues also
 * disable Send, matching what the send path enforces anyway.
 */
function DraftIssues({ subject, content }: { subject: string | null; content: string }) {
  const issues = React.useMemo(() => inspectDraft({ subject, content }), [subject, content]);
  if (issues.length === 0) return null;

  const blocking = issues.filter((issue) => issue.blocking);
  const severe = blocking.length > 0;

  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-2.5 rounded-md border px-3 py-2.5',
        severe ? 'border-warning/40 bg-warning-subtle' : 'border-border bg-muted',
      )}
    >
      <AlertTriangle
        className={cn('mt-0.5 size-4 shrink-0', severe ? 'text-warning' : 'text-muted-foreground')}
        aria-hidden="true"
      />
      <div className="min-w-0 space-y-1 text-xs">
        <p className={cn('font-medium', severe ? 'text-warning' : 'text-foreground')}>
          {severe ? 'This draft cannot be sent yet' : 'Worth a look before sending'}
        </p>
        <ul className="space-y-0.5 text-muted-foreground">
          {issues.map((issue) => (
            <li key={issue.kind}>
              {issue.message}
              {issue.sample ? (
                <code className="ml-1.5 rounded bg-surface px-1 py-0.5 font-mono break-all">
                  {issue.sample.slice(0, 60)}
                </code>
              ) : null}
            </li>
          ))}
        </ul>
        {blocking.some((i) => i.kind === 'structured' || i.kind === 'escaped_newlines') ? (
          <p className="text-muted-foreground">
            Settings → Draft quality → <strong>Clean and approve drafts</strong> unwraps this
            automatically and keeps the original as a version.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/*
 * This chip describes ONE DRAFT, and a lead has three of them — initial,
 * follow-up 1, follow-up 2. So it says "Approved" and not "Initial Approved":
 * the latter was applied here by a find-and-replace and read wrong on every
 * follow-up. "Initial approved" is a fact about the LEAD, and lives on the
 * pipeline panel where the gate it describes actually is.
 */
function StatusChip({ version }: { version: EmailVersion }) {
  if (version.status === 'approved') {
    return (
      <Badge tone="success">
        <CheckCircle2 className="size-3" aria-hidden="true" />
        Approved
      </Badge>
    );
  }
  if (version.status === 'rejected') {
    return (
      <Badge tone="danger">
        <XCircle className="size-3" aria-hidden="true" />
        Rejected
      </Badge>
    );
  }
  return (
    <Badge tone="neutral">
      <Clock className="size-3" aria-hidden="true" />
      Awaiting review
    </Badge>
  );
}

function DraftEditor({
  leadId,
  type,
  versions,
  hasEmail,
  alreadySent,
}: {
  leadId: string;
  type: EmailType;
  versions: EmailVersion[];
  hasEmail: boolean;
  alreadySent: boolean;
}) {
  const [state, formAction, saving] = useActionState(saveDraft, EMPTY_ACTION_RESULT);
  const { busy, run } = useAsyncAction();
  const [showHistory, setShowHistory] = React.useState(false);

  const active = versions.find((v) => v.active) ?? versions[0] ?? null;
  // Hooks cannot sit behind the early return below, so this runs for the
  // empty-state case too hence the null-safe arguments.
  const blocking = useBlockingIssues(active?.subject ?? null, active?.content ?? '');

  if (!active) {
    return (
      <div className="space-y-3">
        <EmptyState
          icon={Sparkles}
          title={`No ${EMAIL_TYPE_LABELS[type].toLowerCase()} yet`}
          description="Generate one from the research and personalization, or write it by hand below."
          action={
            <Button
              variant="primary"
              loading={busy === 'regen'}
              onClick={() => run('regen', () => regenerateDraft(leadId, type))}
            >
              <Sparkles className="size-4" aria-hidden="true" />
              Generate draft
            </Button>
          }
        />

        <form action={formAction} className="space-y-3 border-t border-border pt-4">
          <input type="hidden" name="leadId" value={leadId} />
          <input type="hidden" name="type" value={type} />
          <Field label="Subject line" htmlFor={`subject-${type}`}>
            <Input id={`subject-${type}`} name="subject" maxLength={300} />
          </Field>
          <Field label="Email body" htmlFor={`content-${type}`}>
            <Textarea
              id={`content-${type}`}
              name="content"
              rows={12}
              className="font-mono text-xs leading-relaxed"
              required
            />
          </Field>
          <PanelError state={state} />
          <div className="flex justify-end">
            <Button type="submit" variant="secondary" loading={saving}>
              <Save className="size-4" aria-hidden="true" />
              Save as version 1
            </Button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="primary">Version {active.version_number}</Badge>
        <StatusChip version={active} />
        <Badge tone="neutral" title="How this version was produced">
          {active.generated_by}
        </Badge>
        <span className="text-xs text-muted-foreground">
          Created {formatRelative(active.created_at)}
        </span>
        <div className="flex-1" />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setShowHistory((open) => !open)}
          aria-expanded={showHistory}
        >
          <History className="size-3.5" aria-hidden="true" />
          {versions.length} version{versions.length === 1 ? '' : 's'}
        </Button>
      </div>

      {active.review_note ? (
        <p className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
          <span className="font-medium">Review note:</span> {active.review_note}
        </p>
      ) : null}

      <DraftIssues subject={active.subject} content={active.content} />

      <DraftForm
        key={active.id}
        leadId={leadId}
        type={type}
        version={active}
        state={state}
        formAction={formAction}
        saving={saving}
      />

      <div className="flex flex-wrap gap-2 border-t border-border pt-4">
        <Button
          type="button"
          variant="secondary"
          loading={busy === 'regen'}
          onClick={() => run('regen', () => regenerateDraft(leadId, type))}
          title="Generates a completely new draft and saves it as the next version"
        >
          <RefreshCw className="size-4" aria-hidden="true" />
          Regenerate
        </Button>

        <Button
          type="button"
          variant="secondary"
          loading={busy === 'approve'}
          disabled={active.status === 'approved'}
          onClick={() => run('approve', () => approveVersion(active.id, leadId))}
        >
          <CheckCircle2 className="size-4" aria-hidden="true" />
          {active.status === 'approved' ? 'Approved' : 'Approve'}
        </Button>

        <Button
          type="button"
          variant="secondary"
          loading={busy === 'reject'}
          disabled={active.status === 'rejected'}
          onClick={() => run('reject', () => rejectVersion(active.id, leadId))}
          title="Keeps the version in the history; it just stops being sendable"
        >
          <XCircle className="size-4" aria-hidden="true" />
          Reject
        </Button>

        <div className="flex-1" />

        <Button
          type="button"
          variant="primary"
          loading={busy === 'send'}
          disabled={!hasEmail || alreadySent || active.status === 'rejected' || blocking.length > 0}
          title={
            !hasEmail
              ? 'This lead has no email address'
              : alreadySent
                ? `${EMAIL_TYPE_LABELS[type]} has already been sent`
                : active.status === 'rejected'
                  ? 'This version was rejected'
                  : blocking.length > 0
                    ? blocking.map((i) => i.message).join(' ')
                    : `Send ${EMAIL_TYPE_LABELS[type].toLowerCase()} now`
          }
          onClick={() => run('send', () => sendEmail(leadId, type))}
        >
          <Send className="size-4" aria-hidden="true" />
          {alreadySent ? 'Already sent' : `Send ${EMAIL_TYPE_LABELS[type].toLowerCase()}`}
        </Button>
      </div>

      {showHistory ? (
        <VersionHistory
          leadId={leadId}
          versions={versions}
          activeId={active.id}
          busy={busy}
          onActivate={(versionId) => run(`act-${versionId}`, () => activateVersion(versionId, leadId))}
        />
      ) : null}
    </div>
  );
}

function DraftForm({
  leadId,
  type,
  version,
  state,
  formAction,
  saving,
}: {
  leadId: string;
  type: EmailType;
  version: EmailVersion;
  state: typeof EMPTY_ACTION_RESULT;
  formAction: (formData: FormData) => void;
  saving: boolean;
}) {
  useActionFeedback(state);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="type" value={type} />

      <Field label="Subject line" htmlFor={`subject-${type}`}>
        <Input
          id={`subject-${type}`}
          name="subject"
          defaultValue={version.subject ?? ''}
          maxLength={300}
        />
      </Field>

      <Field
        label="Email body"
        htmlFor={`content-${type}`}
        hint="Placeholders like {{business_name}} and {{signature}} are resolved when the email is sent."
      >
        <Textarea
          id={`content-${type}`}
          name="content"
          defaultValue={version.content}
          rows={16}
          className="font-mono text-xs leading-relaxed"
          required
        />
      </Field>

      <PanelError state={state} />

      <div className="flex justify-end">
        <Button
          type="submit"
          variant="secondary"
          loading={saving}
          title="Saves your edit as a new version. The current one stays in the history."
        >
          <Save className="size-4" aria-hidden="true" />
          Save as version {version.version_number + 1}
        </Button>
      </div>
    </form>
  );
}

function VersionHistory({
  versions,
  activeId,
  busy,
  onActivate,
}: {
  leadId: string;
  versions: EmailVersion[];
  activeId: string;
  busy: string | null;
  onActivate: (versionId: string) => void;
}) {
  return (
    <div className="rounded-lg border border-border">
      <p className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
        Version history any version can be made active again
      </p>
      <ul className="divide-y divide-border">
        {versions.map((version) => {
          const isActive = version.id === activeId;
          return (
            <li key={version.id} className="px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="tabular text-sm font-medium">v{version.version_number}</span>
                <StatusChip version={version} />
                {isActive ? <Badge tone="primary">Active</Badge> : null}
                <span className="text-xs text-muted-foreground">{version.generated_by}</span>
                <span className="tabular text-xs text-muted-foreground">
                  {formatDateTime(version.created_at)}
                </span>
                <div className="flex-1" />
                {!isActive ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    loading={busy === `act-${version.id}`}
                    onClick={() => onActivate(version.id)}
                  >
                    Make active
                  </Button>
                ) : null}
              </div>
              <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                {version.subject ? <span className="font-medium">{version.subject} </span> : null}
                {version.content.slice(0, 220)}
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
