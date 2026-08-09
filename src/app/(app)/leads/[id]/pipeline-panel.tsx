'use client';

import * as React from 'react';
import { CheckCircle2, Circle, PauseCircle, PlayCircle, RotateCcw, Save, XCircle } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useAsyncAction } from '@/components/action-form';
import {
  closeLeadWorkflow,
  reopenLeadWorkflow,
  setAutoFollowups,
  setPipelineGate,
  setVerificationStatus,
  type PipelineGate,
} from '@/lib/actions/review';
import { SEND_PRIORITY_META, VERIFICATION_META } from '@/lib/pipeline/labels';
import { formatDateTime, formatRelative } from '@/lib/utils';
import {
  EMAIL_VERIFICATION_STATUSES,
  type EmailVerificationStatus,
  type PipelineBoardRow,
} from '@/lib/supabase/database.types';

/**
 * Stage controls.
 *
 * The gates are the only pipeline state a human can assert. The stage itself is
 * derived from them in Postgres, so this panel deliberately offers no way to
 * "set the stage" that would be a second source of truth, and the losing one.
 *
 * The email gate is a DROPDOWN, not a tick box, because the thing it records has
 * five values and a tick box can show two. Catch-all and unknown rendered as an
 * empty circle indistinguishable from "nobody has checked", so 173 addresses
 * that a verifier had already answered on read as unchecked — on this panel and
 * on the dashboard. It is first because it is the first gate: nothing below it
 * matters until there is an address worth writing to.
 */

const GATES: Array<{ key: PipelineGate; label: string; hint: string }> = [
  { key: 'research_complete', label: 'Research complete', hint: 'Enough is known to write a draft.' },
  { key: 'draft_ready', label: 'Initial draft written', hint: 'An initial email exists and is worth reviewing.' },
  {
    key: 'approved',
    label: 'Initial email approved',
    hint: 'The FIRST email is signed off and eligible to send. Follow-ups are approved on their own tabs and do not affect this.',
  },
];

export function PipelinePanel({ pipeline }: { pipeline: PipelineBoardRow }) {
  const { busy, run } = useAsyncAction();
  const [confirmClose, setConfirmClose] = React.useState(false);

  const closed = pipeline.closed !== null;
  const verification = pipeline.email_verification_status;

  /*
   * The verification verdict is CHOSEN here and COMMITTED by the Save button,
   * rather than writing the moment the select changes.
   *
   * Everything else on this page works that way — Business information, the
   * research panels, the draft editor all stage an edit and wait for Save — and
   * a control that saved on change was the odd one out in a way that mattered:
   * marking an address dead removes the lead from every queue and can stop the
   * sender, so brushing the wrong option with a scroll wheel had consequences
   * and no undo prompt. The gates below are single clicks with obvious meanings
   * and keep committing immediately.
   *
   * `saved` tracks the value this component last rendered from the server, so
   * when a save completes and the page revalidates, the fresh prop resets the
   * selection instead of leaving it looking dirty. Comparing during render
   * rather than in an effect is the same idiom lead-detail.tsx uses: setting
   * state inside an effect costs an extra cascading render.
   */
  const [choice, setChoice] = React.useState<EmailVerificationStatus>(verification);
  const [saved, setSaved] = React.useState<EmailVerificationStatus>(verification);
  if (verification !== saved) {
    setSaved(verification);
    setChoice(verification);
  }

  const verificationDirty = choice !== verification;

  const stamps: Array<[string, string | null]> = [
    ['Initial sent', pipeline.first_email_sent],
    ['Follow-up 1 due', pipeline.followup1_due],
    ['Follow-up 1 sent', pipeline.followup1_sent],
    ['Follow-up 2 due', pipeline.followup2_due],
    ['Follow-up 2 sent', pipeline.followup2_sent],
    ['Replied', pipeline.replied],
    ['Closed', pipeline.closed],
  ].filter(([, value]) => value !== null) as Array<[string, string]>;

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Pipeline</CardTitle>
          <CardDescription>Stage is derived from these. Mark what is true.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1 rounded-md px-2 py-1.5">
          <label htmlFor="verification-status" className="block text-sm">
            Email address
          </label>
          <Select
            id="verification-status"
            value={choice}
            disabled={busy === 'verification' || !pipeline.email}
            onChange={(event) => setChoice(event.target.value as EmailVerificationStatus)}
          >
            {EMAIL_VERIFICATION_STATUSES.map((status) => (
              <option key={status} value={status}>
                {status === 'unverified' ? 'Never checked' : VERIFICATION_META[status].label}
              </option>
            ))}
          </Select>

          {/* The hint follows the SELECTION, so it describes what Save will do. */}
          <p className="text-xs text-muted-foreground">
            {!pipeline.email
              ? 'No address on file yet. Nothing to verify until one is found.'
              : VERIFICATION_META[choice].hint}
          </p>

          {verificationDirty ? (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                type="button"
                size="sm"
                loading={busy === 'verification'}
                onClick={() =>
                  run('verification', () => setVerificationStatus(pipeline.lead_id, choice))
                }
              >
                <Save className="size-3.5" aria-hidden="true" />
                Save
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy === 'verification'}
                onClick={() => setChoice(verification)}
              >
                Cancel
              </Button>
              <span className="text-xs text-warning">Not saved yet</span>
            </div>
          ) : null}

          {pipeline.email_checked_at ? (
            <p className="text-xs text-muted-foreground">
              {pipeline.email_verification_source ?? 'checked'} ·{' '}
              {formatRelative(pipeline.email_checked_at)}
            </p>
          ) : null}

          {/*
            What the VERIFIER said, kept separately from what you said. Without
            this the two are indistinguishable once you override — and the
            difference is the whole basis of the send order below.
          */}
          {pipeline.email_verifier_status &&
          pipeline.email_verifier_status !== pipeline.email_verification_status ? (
            <p className="text-xs text-muted-foreground">
              A verifier said{' '}
              <strong className="text-foreground">
                {VERIFICATION_META[pipeline.email_verifier_status].label}
              </strong>{' '}
              about this address.
            </p>
          ) : null}

          {!verificationDirty && pipeline.email ? (
            <p className="flex flex-wrap items-center gap-1.5 pt-0.5">
              <Badge tone={SEND_PRIORITY_META[pipeline.send_priority]?.tone ?? 'neutral'}>
                {SEND_PRIORITY_META[pipeline.send_priority]?.label ?? 'Not sendable'}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {SEND_PRIORITY_META[pipeline.send_priority]?.hint ?? ''}
              </span>
            </p>
          ) : null}
        </div>

        <ul className="space-y-1">
          {GATES.map((gate) => {
            const done = pipeline[gate.key];
            return (
              <li key={gate.key}>
                <button
                  type="button"
                  disabled={busy === gate.key}
                  onClick={() => run(gate.key, () => setPipelineGate(pipeline.lead_id, gate.key, !done))}
                  aria-pressed={done}
                  title={gate.hint}
                  className="flex w-full cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {done ? (
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
                  ) : (
                    <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  )}
                  <span className="min-w-0">
                    <span className="block text-sm">{gate.label}</span>
                    <span className="block text-xs text-muted-foreground">{gate.hint}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        {stamps.length > 0 ? (
          <dl className="space-y-1 border-t border-border pt-3">
            {stamps.map(([label, value]) => (
              <div key={label} className="flex items-baseline justify-between gap-2">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="tabular text-xs" title={formatDateTime(value)}>
                  {formatRelative(value)}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}

        <div className="space-y-2 border-t border-border pt-3">
          {/*
            Two ways to stop emailing someone, and they mean different things.
            Spelled out because "they replied saying no thanks — do I pause or
            close?" is the question this panel gets asked, and a wrong guess
            either keeps mailing someone who declined or buries a lead who only
            asked to be left alone until next quarter.
          */}
          <p className="text-xs text-muted-foreground">
            <strong className="text-foreground">Pause</strong> keeps the lead live and stops the
            sender for now use it for &ldquo;not right now, try later&rdquo;.{' '}
            <strong className="text-foreground">Close</strong> ends the sequence for good use it
            when they say no, when they reply and the conversation moves to your inbox, or when the
            lead turns out to be wrong. Both keep every draft, reply and log, and both are
            reversible.
          </p>

          <Button
            type="button"
            variant="secondary"
            className="w-full"
            loading={busy === 'auto'}
            onClick={() =>
              run('auto', () => setAutoFollowups(pipeline.lead_id, !pipeline.auto_followups))
            }
            title="Excludes this lead from the scheduled sender without changing the global setting. The lead keeps its stage and stays in every queue."
          >
            {pipeline.auto_followups ? (
              <>
                <PauseCircle className="size-4" aria-hidden="true" />
                Pause automatic follow-ups
              </>
            ) : (
              <>
                <PlayCircle className="size-4" aria-hidden="true" />
                Resume automatic follow-ups
              </>
            )}
          </Button>

          {closed ? (
            <>
              <p className="text-xs text-muted-foreground">
                Closed {formatRelative(pipeline.closed)}
                {pipeline.closed_reason ? ` ${pipeline.closed_reason}` : ''}
              </p>
              <Button
                type="button"
                variant="secondary"
                className="w-full"
                loading={busy === 'reopen'}
                onClick={() => run('reopen', () => reopenLeadWorkflow(pipeline.lead_id))}
              >
                <RotateCcw className="size-4" aria-hidden="true" />
                Reopen workflow
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="secondary"
              className="w-full"
              onClick={() => setConfirmClose(true)}
              title="Ends the sequence. The lead leaves every queue and every dashboard count, and its stage reads Closed."
            >
              <XCircle className="size-4" aria-hidden="true" />
              Close workflow no more emails
            </Button>
          )}
        </div>
      </CardContent>

      <ConfirmDialog
        open={confirmClose}
        onOpenChange={setConfirmClose}
        title="Close this workflow?"
        description="No further emails are sent for this lead, and it drops out of every queue and dashboard count. Its research, drafts, replies and send history are all kept, and Reopen puts it back exactly where it was. This is the right choice when someone replies to say no."
        confirmLabel="Close workflow"
        onConfirm={() =>
          run('close', () => closeLeadWorkflow(pipeline.lead_id, 'Closed by an administrator')).then(
            () => undefined,
          )
        }
      />
    </Card>
  );
}
