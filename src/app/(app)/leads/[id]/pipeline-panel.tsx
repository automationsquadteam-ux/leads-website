'use client';

import * as React from 'react';
import { CheckCircle2, Circle, PauseCircle, PlayCircle, RotateCcw, XCircle } from 'lucide-react';

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
import { VERIFICATION_META } from '@/lib/pipeline/labels';
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
  { key: 'draft_ready', label: 'Draft ready', hint: 'An initial email exists and is worth reviewing.' },
  { key: 'approved', label: 'Approved', hint: 'Signed off and eligible to send.' },
];

export function PipelinePanel({ pipeline }: { pipeline: PipelineBoardRow }) {
  const { busy, run } = useAsyncAction();
  const [confirmClose, setConfirmClose] = React.useState(false);

  const closed = pipeline.closed !== null;
  const verification = pipeline.email_verification_status;

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
            value={verification}
            disabled={busy === 'verification' || !pipeline.email}
            onChange={(event) =>
              run('verification', () =>
                setVerificationStatus(
                  pipeline.lead_id,
                  event.target.value as EmailVerificationStatus,
                ),
              )
            }
          >
            {EMAIL_VERIFICATION_STATUSES.map((status) => (
              <option key={status} value={status}>
                {status === 'unverified' ? 'Never checked' : VERIFICATION_META[status].label}
              </option>
            ))}
          </Select>
          <p className="text-xs text-muted-foreground">
            {!pipeline.email
              ? 'No address on file yet. Nothing to verify until one is found.'
              : VERIFICATION_META[verification].hint}
          </p>
          {pipeline.email_checked_at ? (
            <p className="text-xs text-muted-foreground">
              {pipeline.email_verification_source ?? 'checked'} ·{' '}
              {formatRelative(pipeline.email_checked_at)}
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
          <Button
            type="button"
            variant="secondary"
            className="w-full"
            loading={busy === 'auto'}
            onClick={() =>
              run('auto', () => setAutoFollowups(pipeline.lead_id, !pipeline.auto_followups))
            }
            title="Excludes this lead from the scheduled sender without changing the global setting"
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
            >
              <XCircle className="size-4" aria-hidden="true" />
              Close workflow
            </Button>
          )}
        </div>
      </CardContent>

      <ConfirmDialog
        open={confirmClose}
        onOpenChange={setConfirmClose}
        title="Close this workflow?"
        description="No further emails are sent for this lead. Everything is kept and you can reopen it at any time."
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
