'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  AlertTriangle, Check, CheckCircle2, EyeOff, Link2, Loader2, MailX, Search, X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/empty-state';
import { SentimentBadge } from '@/components/status-badge';
import { useAsyncAction } from '@/components/action-form';
import {
  assignInboundMessage, findLeads, ignoreInboundMessage,
  markInboundHandled, setInboundSentiment,
} from '@/lib/actions/inbox';
import type { LeadOption } from '@/lib/data/inbox';
import type { InboundInboxRow } from '@/lib/supabase/database.types';
import { cn, formatDateTime, formatRelative } from '@/lib/utils';

/**
 * The Replies inbox.
 *
 * Two lists that behave differently on purpose: unmatched messages need a
 * decision, matched ones need reading. Putting them in one undifferentiated
 * feed would bury the ones that actually require work.
 */

export function InboxClient({
  unmatched,
  matched,
  bounces,
  autoReplies,
}: {
  unmatched: InboundInboxRow[];
  matched: InboundInboxRow[];
  bounces: InboundInboxRow[];
  autoReplies: InboundInboxRow[];
}) {
  const [tab, setTab] = React.useState<'unmatched' | 'matched' | 'bounces' | 'auto'>(
    unmatched.length > 0 ? 'unmatched' : 'matched',
  );

  const tabs = [
    { key: 'unmatched' as const, label: 'Needs assigning', count: unmatched.length },
    { key: 'matched' as const, label: 'Replies', count: matched.length },
    { key: 'bounces' as const, label: 'Bounces', count: bounces.length },
    { key: 'auto' as const, label: 'Auto-replies', count: autoReplies.length },
  ];

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Inbox sections" className="flex flex-wrap gap-1 border-b border-border">
        {tabs.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={tab === entry.key}
            onClick={() => setTab(entry.key)}
            className={cn(
              '-mb-px cursor-pointer border-b-2 px-3 py-2.5 text-sm font-medium transition-colors',
              tab === entry.key
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            <span className="flex items-center gap-1.5">
              {entry.label}
              {entry.count > 0 ? (
                <span className="tabular rounded bg-muted px-1.5 text-[10px] text-muted-foreground">
                  {entry.count}
                </span>
              ) : null}
            </span>
          </button>
        ))}
      </div>

      {tab === 'unmatched' ? <UnmatchedList rows={unmatched} /> : null}
      {tab === 'matched' ? <MatchedList rows={matched} /> : null}
      {tab === 'bounces' ? <BounceList rows={bounces} /> : null}
      {tab === 'auto' ? <AutoReplyList rows={autoReplies} /> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function MessageHeader({ row }: { row: InboundInboxRow }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-mono text-xs text-muted-foreground">
        {row.from_name ? `${row.from_name} <${row.from_address}>` : row.from_address}
      </span>
      <div className="flex-1" />
      <span className="tabular text-xs text-muted-foreground" title={formatDateTime(row.received_at)}>
        {formatRelative(row.received_at)}
      </span>
    </div>
  );
}

function UnmatchedList({ rows }: { rows: InboundInboxRow[] }) {
  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="p-0">
          <EmptyState
            icon={CheckCircle2}
            title="Nothing waiting"
            description="Every message that arrived has been attributed to a lead."
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {rows.map((row) => (
        <UnmatchedCard key={row.id} row={row} />
      ))}
    </div>
  );
}

/**
 * One unattributed message plus a lead picker.
 *
 * Automatic matching could not attribute this, usually because the person
 * replied from a different address than the one we mailed. Recognising the
 * business by name takes a human two seconds, so the job here is to make that
 * two seconds cheap rather than to guess.
 */
function UnmatchedCard({ row }: { row: InboundInboxRow }) {
  const { busy, run } = useAsyncAction();
  const [term, setTerm] = React.useState('');
  const [open, setOpen] = React.useState(false);

  /*
   * Results are stored WITH the term that produced them, and everything else is
   * derived during render.
   *
   * The obvious version clears results and flips a "searching" flag at the top
   * of the effect, but a synchronous setState inside an effect body triggers a
   * cascading render and the React Compiler lint rejects it outright. Pairing
   * the rows with their query means "are these stale?" and "are we waiting?"
   * are both answerable without storing them.
   */
  const [results, setResults] = React.useState<{ term: string; rows: LeadOption[] }>({
    term: '',
    rows: [],
  });

  const query = term.trim();
  const fresh = results.term === query;
  const shown = query.length >= 2 && fresh ? results.rows : [];
  const searching = query.length >= 2 && !fresh;

  // Debounced lookup. The only setState here is inside an async callback, which
  // is a subscription-style update rather than a synchronous cascade.
  React.useEffect(() => {
    if (query.length < 2) return;

    let cancelled = false;
    const timer = setTimeout(async () => {
      const rows = await findLeads(query);
      if (!cancelled) setResults({ term: query, rows });
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  return (
    <Card>
      <CardContent className="space-y-3">
        <MessageHeader row={row} />

        {row.subject ? <p className="text-sm font-medium">{row.subject}</p> : null}
        <p className="text-sm leading-relaxed whitespace-pre-line text-muted-foreground">
          {row.body_text?.slice(0, 1200) || 'No text content.'}
        </p>

        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          {row.sentiment ? <SentimentBadge sentiment={row.sentiment} /> : null}

          {!open ? (
            <>
              <Button type="button" size="sm" variant="primary" onClick={() => setOpen(true)}>
                <Link2 className="size-3.5" aria-hidden="true" />
                Assign to lead
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                loading={busy === 'ignore'}
                onClick={() => run('ignore', () => ignoreInboundMessage(row.id))}
                title="Not outreach-related. The message is kept, just set aside."
              >
                <EyeOff className="size-3.5" aria-hidden="true" />
                Not relevant
              </Button>
            </>
          ) : (
            <div className="w-full space-y-2">
              <div className="flex items-center gap-2">
                <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <Input
                  value={term}
                  onChange={(e) => setTerm(e.target.value)}
                  placeholder="Search by business name, email or website..."
                  aria-label="Search leads"
                  autoFocus
                />
                {searching ? (
                  <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setOpen(false);
                    setTerm('');
                  }}
                >
                  <X className="size-3.5" aria-hidden="true" />
                </Button>
              </div>

              {shown.length > 0 ? (
                <ul className="max-h-64 overflow-y-auto rounded-md border border-border">
                  {shown.map((lead) => (
                    <li key={lead.id} className="border-b border-border last:border-0">
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => run(`assign-${lead.id}`, () => assignInboundMessage(row.id, lead.id))}
                        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left hover:bg-surface-hover disabled:opacity-60"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{lead.business_name}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {[lead.email, lead.city, lead.country].filter(Boolean).join(' · ')}
                          </span>
                        </span>
                        {busy === `assign-${lead.id}` ? (
                          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                        ) : (
                          <Check className="size-4 text-muted-foreground" aria-hidden="true" />
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : query.length >= 2 && !searching ? (
                <p className="px-1 text-xs text-muted-foreground">No leads match that.</p>
              ) : null}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function MatchedList({ rows }: { rows: InboundInboxRow[] }) {
  const { busy, run } = useAsyncAction();

  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="p-0">
          <EmptyState
            title="No replies yet"
            description="Once inbound mail arrives and is attributed to a lead, it appears here."
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-0">
        <ul className="divide-y divide-border">
          {rows.map((row) => (
            <li key={row.id} className="px-4 py-3.5">
              <div className="mb-1.5 flex flex-wrap items-center gap-2">
                {row.lead_id ? (
                  <Link
                    href={`/leads/${row.lead_id}`}
                    className="text-sm font-medium hover:text-primary hover:underline"
                  >
                    {row.business_name ?? 'Unknown business'}
                  </Link>
                ) : (
                  <span className="text-sm font-medium">{row.business_name ?? 'Unknown business'}</span>
                )}
                <SentimentBadge sentiment={row.sentiment} />
                {row.match_method === 'manual' ? <Badge tone="neutral">Assigned by hand</Badge> : null}
                {!row.is_handled ? <Badge tone="warning">Needs review</Badge> : null}
                <div className="flex-1" />
                <span className="tabular text-xs text-muted-foreground">
                  {formatDateTime(row.received_at)}
                </span>
              </div>

              <p className="text-sm leading-relaxed whitespace-pre-line text-muted-foreground">
                {row.body_text?.slice(0, 600) || '—'}
              </p>

              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {(['positive', 'neutral', 'negative', 'unsubscribe'] as const).map((option) => (
                  <Button
                    key={option}
                    type="button"
                    size="sm"
                    variant="ghost"
                    loading={busy === `${row.id}-${option}`}
                    disabled={row.sentiment === option}
                    onClick={() => run(`${row.id}-${option}`, () => setInboundSentiment(row.id, option))}
                    className="text-xs"
                  >
                    {option}
                  </Button>
                ))}
                <div className="flex-1" />
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  loading={busy === `${row.id}-handled`}
                  onClick={() => run(`${row.id}-handled`, () => markInboundHandled(row.id, !row.is_handled))}
                >
                  {row.is_handled ? 'Reopen' : 'Mark handled'}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function BounceList({ rows }: { rows: InboundInboxRow[] }) {
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Bounces</CardTitle>
          <CardDescription>
            A hard bounce marks the address invalid and sends the lead back to Need Email. Soft
            bounces (mailbox full, greylisted) change nothing.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <EmptyState icon={MailX} title="No bounces" />
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((row) => (
              <li key={row.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <AlertTriangle className="size-3.5 shrink-0 text-warning" aria-hidden="true" />
                  {row.lead_id ? (
                    <Link href={`/leads/${row.lead_id}`} className="text-sm font-medium hover:underline">
                      {row.business_name ?? 'Unknown business'}
                    </Link>
                  ) : (
                    <span className="text-sm text-muted-foreground">Unattributed</span>
                  )}
                  <div className="flex-1" />
                  <span className="tabular text-xs text-muted-foreground">
                    {formatRelative(row.received_at)}
                  </span>
                </div>
                <p className="mt-1 truncate text-xs text-muted-foreground">{row.subject ?? '—'}</p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function AutoReplyList({ rows }: { rows: InboundInboxRow[] }) {
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Auto-replies</CardTitle>
          <CardDescription>
            Out-of-office and autoresponders. Recorded but deliberately not counted as replies, so
            they neither stop a follow-up sequence nor inflate the reply rate.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <EmptyState title="No auto-replies" />
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((row) => (
              <li key={row.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {row.business_name ?? row.from_address}
                  </span>
                  <span className="tabular text-xs text-muted-foreground">
                    {formatRelative(row.received_at)}
                  </span>
                </div>
                <p className="mt-1 truncate text-xs text-muted-foreground">{row.subject ?? '—'}</p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
