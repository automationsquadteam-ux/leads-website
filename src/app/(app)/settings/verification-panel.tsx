'use client';

import * as React from 'react';
import Link from 'next/link';
import { useActionState } from 'react';
import { Download, ListChecks, Upload } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/input';
import { EMPTY_ACTION_RESULT, PanelError, useActionFeedback, useAsyncAction } from '@/components/action-form';
import { generateMissingFollowups, uploadVerificationCsv } from '@/lib/actions/verification';
import { VERIFICATION_META } from '@/lib/pipeline/labels';
import { EMAIL_VERIFICATION_STATUSES } from '@/lib/supabase/database.types';
import { formatNumber } from '@/lib/utils';

/**
 * The verification round trip, without the terminal.
 *
 * Download, upload, and the counts that tell you whether it worked. The same
 * services back `npm run emails:export` / `emails:import`, so a CSV handled here
 * and one handled from the command line produce identical state.
 */
export function VerificationPanel({
  counts,
  noAddress,
  exportable,
  inconclusive,
  sentWithoutFollowups,
  leadsMissingFollowups,
}: {
  counts: Record<string, number>;
  noAddress: number;
  exportable: number;
  inconclusive: number;
  sentWithoutFollowups: number;
  leadsMissingFollowups: number;
}) {
  const [state, formAction, uploading] = useActionState(uploadVerificationCsv, EMPTY_ACTION_RESULT);
  const { busy, run } = useAsyncAction();
  const [fileName, setFileName] = React.useState<string | null>(null);

  useActionFeedback(state);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Email verification</CardTitle>
            <CardDescription>
              Download the addresses with no definite verdict, run them through NeverBounce (or
              ZeroBounce, or Bouncer), then upload the result here.
            </CardDescription>
          </div>
          <Badge tone={exportable > 0 ? 'warning' : 'success'}>
            {formatNumber(exportable)} to check
          </Badge>
        </CardHeader>

        <CardContent className="space-y-4">
          {/*
            "No address" is listed first and separately because it used to be
            folded into Unverified, where it made the tile promise work the
            download could not deliver: 308 unverified, 184 in the file. An
            address you do not have is a sourcing problem, not a verification
            one.
          */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Link
              href="/leads?view=missing_email"
              title="No address at all. Nothing to verify — these need one found."
              className="rounded-md border border-dashed border-border px-2.5 py-2 transition-colors hover:border-primary hover:bg-surface-hover"
            >
              <span className="block text-xs text-muted-foreground">No address</span>
              <span className="tabular block text-lg font-semibold">{formatNumber(noAddress)}</span>
            </Link>

            {EMAIL_VERIFICATION_STATUSES.map((status) => {
              const meta = VERIFICATION_META[status];
              // Unverified is shown as "addresses never checked", excluding the
              // no-address rows already counted in the tile above.
              const value = status === 'unverified' ? exportable : (counts[status] ?? 0);
              return (
                <Link
                  key={status}
                  href={`/leads?verify=${status}`}
                  title={meta.hint}
                  className="rounded-md border border-border px-2.5 py-2 transition-colors hover:border-primary hover:bg-surface-hover"
                >
                  <span className="block text-xs text-muted-foreground">
                    {status === 'unverified' ? 'Never checked' : meta.label}
                  </span>
                  <span className="tabular block text-lg font-semibold">{formatNumber(value)}</span>
                </Link>
              );
            })}
          </div>

          <div className="space-y-2 border-t border-border pt-4">
            <div className="flex flex-wrap items-center gap-2">
              <a
                href="/api/admin/emails/unverified.csv"
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary-hover"
              >
                <Download className="size-4" aria-hidden="true" />
                Download never-checked ({formatNumber(exportable)})
              </a>

              {inconclusive > 0 ? (
                <a
                  href="/api/admin/emails/unverified.csv?recheck=1"
                  className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-hover"
                  title="Also re-checks catch-all and unknown. Costs credits you have already spent once."
                >
                  <Download className="size-4" aria-hidden="true" />
                  Also re-check catch-all &amp; unknown ({formatNumber(exportable + inconclusive)})
                </a>
              ) : null}
            </div>

            <p className="text-xs text-muted-foreground">
              The main download contains <strong>only addresses never checked before</strong>, so
              re-running it never spends a credit twice. Leads with no address are excluded — you
              cannot verify one you do not have. The second button deliberately re-checks the{' '}
              {formatNumber(inconclusive)} catch-all and unknown results; worth doing occasionally,
              but a catch-all domain returns catch-all every time, so it usually buys nothing.
            </p>
          </div>

          <form action={formAction} className="space-y-3 border-t border-border pt-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Result CSV" htmlFor="verify-file" className="sm:col-span-2">
                <Input
                  id="verify-file"
                  name="file"
                  type="file"
                  accept=".csv,text/csv"
                  required
                  onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
                  className="cursor-pointer file:mr-3 file:cursor-pointer file:rounded file:border-0 file:bg-muted file:px-2 file:py-1 file:text-xs"
                />
              </Field>

              <Field label="Verifier" htmlFor="verify-source" hint="Recorded against each result.">
                <Select id="verify-source" name="source" defaultValue="neverbounce">
                  <option value="neverbounce">NeverBounce</option>
                  <option value="zerobounce">ZeroBounce</option>
                  <option value="bouncer">Bouncer</option>
                  <option value="manual">Other / manual</option>
                </Select>
              </Field>
            </div>

            <PanelError state={state} />

            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" variant="secondary" loading={uploading}>
                <Upload className="size-4" aria-hidden="true" />
                Apply results
              </Button>
              {fileName ? (
                <span className="text-xs text-muted-foreground">{fileName}</span>
              ) : null}
            </div>

            <p className="text-xs text-muted-foreground">
              Matching is on the address, so the file can come back in any order with any extra
              columns. <strong>Valid</strong> becomes verified and sendable.{' '}
              <strong>Invalid</strong> sends the lead back to Need Email so someone finds a new
              address. <strong>Catch-all</strong> and <strong>unknown</strong> are recorded but not
              auto-verified, because those checks proved nothing.
            </p>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Follow-up drafts</CardTitle>
            <CardDescription>
              Write follow-up 1 and 2 ahead of time for leads the initial email has gone to.
            </CardDescription>
          </div>
          {/*
            Leads first, drafts second. The badge used to show the draft count
            alone, so 60 emailed leads produced "118 missing" and read like a
            contradiction — each lead needs two drafts.
          */}
          <Badge tone={leadsMissingFollowups > 0 ? 'warning' : 'neutral'}>
            {formatNumber(leadsMissingFollowups)} lead{leadsMissingFollowups === 1 ? '' : 's'}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm">
            <strong>{formatNumber(leadsMissingFollowups)}</strong> lead
            {leadsMissingFollowups === 1 ? '' : 's'} you have already emailed{' '}
            {leadsMissingFollowups === 1 ? 'is' : 'are'} missing a follow-up, which is{' '}
            <strong>{formatNumber(sentWithoutFollowups)}</strong> draft
            {sentWithoutFollowups === 1 ? '' : 's'} to write (each lead needs follow-up 1 and
            follow-up 2).
          </p>

          <Button
            type="button"
            variant="secondary"
            loading={busy === 'followups'}
            onClick={() => run('followups', () => generateMissingFollowups())}
          >
            <ListChecks className="size-4" aria-hidden="true" />
            Generate missing follow-up drafts
          </Button>

          <p className="text-xs text-muted-foreground">
            The scheduled sender already writes a missing follow-up on the day it is due, so this
            is not required for the sequence to run. It exists so you can read and edit the drafts
            in advance rather than finding out what they said afterwards. Leads that already have a
            draft for a step are left alone, so this is safe to press twice. It works in batches of
            100 and stops before the request times out, so press it again if there are more.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
