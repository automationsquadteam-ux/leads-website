'use client';

import * as React from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import {
  Users, ExternalLink, Archive, CheckCircle2, Download, Search, Trash2, MailCheck, Pencil, Save, X,
} from 'lucide-react';

import { DataTable, type Column } from '@/components/data-table';
import { SearchBar } from '@/components/search-bar';
import { FilterPanel, ActiveFilters } from '@/components/filter-panel';
import { Pagination } from '@/components/pagination';
import { EmptyState } from '@/components/empty-state';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { NextStepBadge, StageBadge } from '@/components/pipeline-badge';
import {
  archiveLeads, bulkApproveDrafts, bulkMarkEmailVerified, bulkUpdateEmails, deleteLeads,
} from '@/lib/actions/leads';
import { VERIFICATION_META } from '@/lib/pipeline/labels';
import type { LeadRow } from '@/lib/data/leads';
import {
  EMAIL_VERIFICATION_STATUSES,
  type EmailVerificationStatus,
  type PipelineStage,
} from '@/lib/supabase/database.types';
import { cn, displayUrl, formatDate, formatNumber, googleSearchUrl } from '@/lib/utils';

interface Props {
  rows: LeadRow[];
  total: number;
  page: number;
  pageSize: number;
  search: string;
  stages: PipelineStage[];
  verification: EmailVerificationStatus[];
  hasWebsite?: 'yes' | 'no';
  archivedOnly: boolean;
  /** Active named view, so the chips can show which one is on. */
  view?: string;
  sort: string;
  direction: 'asc' | 'desc';
  facets: Record<string, number>;
}

const DASH = '—';

/**
 * List state lives in the URL, not React state.
 *
 * That makes every view shareable and bookmarkable, keeps the back button
 * working, and means the server component re-runs the query - no client-side
 * cache to invalidate.
 */
export function LeadsTable({
  rows, total, page, pageSize, search, stages, verification, hasWebsite, archivedOnly, view, sort, direction, facets,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { toast } = useToast();

  const [pending, startTransition] = React.useTransition();
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [confirmArchive, setConfirmArchive] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  /*
   * Selected-but-filtered-out rows stay visible until Clear.
   *
   * The list is a live query, not a snapshot — every filter/stage/verify
   * param in the URL is re-run on the server on every refresh, on purpose,
   * so the numbers never lie. But that collides with a workflow this table
   * exists to support: select a batch of catch-all addresses, fix one,
   * save. Saving resets its verification to "never checked" (deliberately —
   * so Mark verified can run on the corrected address next), which is a
   * DIFFERENT filter value than the one that put it on screen. The next
   * `router.refresh()` re-runs the current filter, the lead no longer
   * matches it, and the row vanishes from `rows` — while `selected` still
   * names it, on purpose, so the next bulk action can still reach it. The
   * result without this cache: a "1 selected" chip with nothing on screen
   * to point it at.
   *
   * `rowCache` accumulates the last known full row for every id this table
   * has ever rendered, so a selected id the server's `rows` no longer
   * contains can still be resurrected below.
   *
   * `cachedFromRows` tracks which `rows` array is already folded into it, and
   * the comparison runs DURING RENDER, not inside a `useEffect` — the same
   * idiom `pipeline-panel.tsx` and `lead-detail.tsx` use for the identical
   * reason: React explicitly supports a conditional `setState` call in the
   * render body as a "bail out and re-render before committing" step, so the
   * cache is already correct on the render that just received new `rows`.
   * Doing this in an effect would cost an extra full commit-then-rerender
   * cycle for something that only needs to be ready in time for THIS render's
   * `pinnedIds`/`displayRows` below — and, separately, this project's lint
   * config rejects `setState` inside an effect entirely (`react-hooks/set-
   * state-in-effect`), so an effect was never the sanctioned option here.
   */
  const [rowCache, setRowCache] = React.useState<Map<string, LeadRow>>(() => {
    const initial = new Map<string, LeadRow>();
    for (const row of rows) initial.set(row.id, row);
    return initial;
  });
  const [cachedFromRows, setCachedFromRows] = React.useState(rows);
  if (rows !== cachedFromRows) {
    setCachedFromRows(rows);
    setRowCache((prev) => {
      const next = new Map(prev);
      for (const row of rows) next.set(row.id, row);
      return next;
    });
  }

  const pinnedIds = React.useMemo(() => {
    const present = new Set(rows.map((r) => r.id));
    return [...selected].filter((id) => !present.has(id) && rowCache.has(id));
  }, [rows, selected, rowCache]);

  const displayRows = React.useMemo(() => {
    if (pinnedIds.length === 0) return rows;
    const pinned = pinnedIds.map((id) => rowCache.get(id)!);
    return [...rows, ...pinned];
  }, [rows, pinnedIds, rowCache]);

  const update = React.useCallback(
    (changes: Record<string, string | null>) => {
      const next = new URLSearchParams(params.toString());
      for (const [key, value] of Object.entries(changes)) {
        if (value === null || value === '') next.delete(key);
        else next.set(key, value);
      }
      // Any change to the query resets paging - page 3 of a new filter is meaningless.
      if (!('page' in changes)) next.delete('page');
      startTransition(() => router.push(`${pathname}?${next.toString()}`, { scroll: false }));
    },
    [params, pathname, router],
  );

  /*
   * Inline address editing.
   *
   * `editingEmails` holds the drafts by lead id while the operator types, so a
   * re-render (a toast, a router refresh) cannot lose half-typed input. It is
   * cleared on Save and on Cancel, never on a selection change — the selection
   * is what says WHICH rows are editable, and clearing one on the other would
   * throw away typing the moment somebody ticks one more box.
   */
  const [emailEdits, setEmailEdits] = React.useState<Record<string, string> | null>(null);
  const editingEmails = emailEdits !== null;

  const saveEmails = React.useCallback(async (): Promise<void> => {
    if (!emailEdits) return;
    // Only rows the operator actually changed. Sending the untouched ones would
    // reset their verification for no reason.
    const changed = Object.entries(emailEdits)
      .filter(([id, value]) => value.trim() !== (rows.find((r) => r.id === id)?.email ?? ''))
      .map(([id, email]) => ({ id, email }));

    if (changed.length === 0) {
      toast('No addresses were changed.', 'error');
      return;
    }
    const result = await bulkUpdateEmails(changed);
    toast(result.message, result.ok ? 'success' : 'error');
    if (result.ok) {
      setEmailEdits(null);
      // Selection deliberately survives, so Verify can run on the same rows.
      startTransition(() => router.refresh());
    }
  }, [emailEdits, rows, toast, router]);

  const columns: Column<LeadRow>[] = React.useMemo(
    () => [
      {
        key: 'business_name',
        header: 'Business Name',
        sortable: true,
        width: 240,
        render: (lead) => (
          <span className="flex min-w-0 items-center gap-1.5">
            <Link
              href={`/leads/${lead.id}`}
              onClick={(e) => e.stopPropagation()}
              className="min-w-0 truncate font-medium text-foreground hover:text-primary hover:underline"
            >
              {lead.business_name}
            </Link>
            {pinnedIds.includes(lead.id) ? (
              <span
                title="Selected, but this lead no longer matches the current filter — likely from your own edit. It stays on screen until you Clear."
                className="shrink-0 rounded border border-warning/40 bg-warning-subtle px-1 py-0.5 text-[10px] font-medium text-warning"
              >
                filtered out
              </span>
            ) : null}
          </span>
        ),
      },
      {
        key: 'website',
        header: 'Website',
        width: 200,
        /*
         * No website is not nothing to say — it is the moment you go and look
         * the business up. A dash sent you off to open a tab and retype the
         * name, so the empty state is a Google search for this business narrowed
         * by its city and country, which is the difference between finding the
         * right Konyha Restaurant and finding forty of them.
         *
         * Shown on EVERY lead without a website, not only the ones missing an
         * address: an address that exists still has to be verified by hand
         * sometimes, and that starts with the same lookup.
         */
        render: (lead) =>
          lead.website ? (
            <a
              href={lead.website}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 text-muted-foreground hover:text-primary hover:underline"
            >
              <span className="max-w-42 truncate">{displayUrl(lead.website)}</span>
              <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
            </a>
          ) : (
            <a
              href={googleSearchUrl(lead.business_name, lead.city, lead.country, 'email')}
              target="_blank"
              rel="noopener noreferrer"
              // The row itself navigates to the lead, so the click must not
              // bubble or you would open the search AND leave the page.
              onClick={(e) => e.stopPropagation()}
              title={`No website on file. Search Google for "${[lead.business_name, lead.city, lead.country, 'email'].filter(Boolean).join(' ')}"`}
              className="inline-flex items-center gap-1 rounded-md border border-dashed border-border px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-primary"
            >
              <Search className="size-3 shrink-0" aria-hidden="true" />
              Look up
            </a>
          ),
      },
      {
        key: 'email',
        header: 'Email',
        width: 220,
        /*
         * Editable in place, but ONLY for selected rows while Edit addresses is
         * on. Sourcing addresses is a batch job — you sit with a list of tabs
         * open and type twenty of them — and making that twenty round trips
         * through the lead page is the difference between doing it and not.
         *
         * `stopPropagation` on every interaction because the row itself
         * navigates to the lead; without it the first click into the field
         * would leave the page.
         */
        render: (lead) => {
          if (editingEmails && selected.has(lead.id)) {
            return (
              <Input
                value={emailEdits?.[lead.id] ?? lead.email ?? ''}
                onChange={(e) =>
                  setEmailEdits((prev) => ({ ...(prev ?? {}), [lead.id]: e.target.value }))
                }
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') void saveEmails();
                }}
                type="email"
                inputMode="email"
                spellCheck={false}
                autoComplete="off"
                placeholder="name@business.com"
                aria-label={`Email address for ${lead.business_name}`}
                className="h-7 font-mono text-xs"
              />
            );
          }
          return lead.email ? (
            <span className="font-mono text-xs">{lead.email}</span>
          ) : (
            <span className="text-muted-foreground">{DASH}</span>
          );
        },
      },
      {
        key: 'verification',
        header: 'Verified',
        width: 130,
        render: (lead) => {
          if (!lead.verification) return <span className="text-muted-foreground">{DASH}</span>;

          // "Unverified" covers two very different situations and the
          // difference is what you act on: no address at all is a SOURCING
          // problem, an unchecked address is a VERIFICATION one. Showing the
          // same word for both sent people looking for a verifier run that
          // could never have applied.
          if (!lead.email) {
            return (
              <Badge tone="neutral" title="No address at all. This needs one found, not verified.">
                No email
              </Badge>
            );
          }

          const meta = VERIFICATION_META[lead.verification];
          return (
            <Badge tone={meta.tone} title={meta.hint}>
              {lead.verification === 'unverified' ? 'Never checked' : meta.label}
            </Badge>
          );
        },
      },
      {
        key: 'phone',
        header: 'Phone',
        width: 140,
        render: (lead) => (
          <span className="tabular text-muted-foreground">{lead.phone ?? DASH}</span>
        ),
      },
      {
        key: 'city',
        header: 'City',
        sortable: true,
        width: 130,
        render: (lead) => (
          <span className="text-muted-foreground">
            {lead.city ?? DASH}
            {lead.country ? <span className="text-muted-foreground/60">, {lead.country}</span> : null}
          </span>
        ),
      },
      {
        key: 'niche',
        header: 'Niche',
        sortable: true,
        width: 150,
        render: (lead) => <span className="text-muted-foreground">{lead.niche ?? DASH}</span>,
      },
      /*
       * Stage and Next Step are the two figures that decide what to do with a
       * lead. Both are derived in Postgres; a null means the pipeline row has
       * not been created yet, which happens only for rows written before
       * migration 0012.
       *
       * A `Status` column used to sit here showing leads.status. It was a label
       * someone set rather than a fact, it disagreed with the stage on hundreds
       * of rows, and having both on screen invited you to trust the wrong one.
       */
      {
        key: 'stage',
        header: 'Stage',
        width: 150,
        render: (lead) =>
          lead.stage ? <StageBadge stage={lead.stage} /> : <span className="text-muted-foreground">{DASH}</span>,
      },
      {
        key: 'nextStep',
        header: 'Next Step',
        width: 175,
        render: (lead) =>
          lead.nextStep ? (
            <NextStepBadge step={lead.nextStep} />
          ) : (
            <span className="text-muted-foreground">{DASH}</span>
          ),
      },
      {
        key: 'last_contacted_at',
        header: 'Last Contacted',
        sortable: true,
        width: 140,
        render: (lead) => (
          <span className="tabular text-muted-foreground">{formatDate(lead.last_contacted_at)}</span>
        ),
      },
    ],
    /*
     * These deps are load-bearing, not tidiness. The array was `[]`, which was
     * correct while every cell was a pure function of its row — but the Email
     * cell now renders an input driven by `emailEdits` and `selected`, and a
     * memo that never re-runs would hand it first-render values: the edit mode
     * would never appear and typing would go nowhere.
     */
    [editingEmails, emailEdits, selected, saveEmails, pinnedIds],
  );

  async function runBulk(action: () => Promise<{ ok: boolean; message: string }>): Promise<void> {
    const result = await action();
    toast(result.message, result.ok ? 'success' : 'error');
    if (result.ok) {
      setSelected(new Set());
      startTransition(() => router.refresh());
    }
  }

  const hasFilters = search !== '' || stages.length > 0 || verification.length > 0 || Boolean(hasWebsite);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchBar
          value={search}
          onChange={(value) => update({ q: value || null })}
          placeholder="Search name, email, website, phone, city, country..."
          pending={pending}
          className="min-w-60"
        />
        <FilterPanel
          selected={stages}
          facets={facets}
          onChange={(next) => update({ stage: next.length > 0 ? next.join(',') : null })}
        />

        {/*
          Verification is its own filter rather than another status chip: it
          answers a different question ("can I email this?") and is the one you
          reach for before a send run.

          "No email" and "Never checked" are named views rather than
          ?verify= values, because both would otherwise be `unverified` — a
          lead with no address has nothing to verify, so it carries that status
          too. Filtering on the raw enum would return all 308 of them under a
          chip that claims to show the handful with an unchecked address.
        */}
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter by email verification">
          <button
            type="button"
            aria-pressed={view === 'missing_email'}
            onClick={() =>
              update({ view: view === 'missing_email' ? null : 'missing_email', verify: null })
            }
            className={cn(
              'cursor-pointer rounded-md border px-2 py-1 text-xs font-medium transition-colors',
              view === 'missing_email'
                ? 'border-primary bg-primary-subtle text-primary'
                : 'border-border text-muted-foreground hover:bg-surface-hover hover:text-foreground',
            )}
            title="No address at all. These need one found, not verified."
          >
            No email
          </button>

          <button
            type="button"
            aria-pressed={view === 'awaiting_verification'}
            onClick={() =>
              update({
                view: view === 'awaiting_verification' ? null : 'awaiting_verification',
                verify: null,
              })
            }
            className={cn(
              'cursor-pointer rounded-md border px-2 py-1 text-xs font-medium transition-colors',
              view === 'awaiting_verification'
                ? 'border-primary bg-primary-subtle text-primary'
                : 'border-border text-muted-foreground hover:bg-surface-hover hover:text-foreground',
            )}
            title="Has an address that has never been sent to a verifier."
          >
            Never checked
          </button>

          {EMAIL_VERIFICATION_STATUSES.filter((s) => s !== 'unverified').map((status) => {
            const active = verification.includes(status);
            return (
              <button
                key={status}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  const next = active
                    ? verification.filter((v) => v !== status)
                    : [...verification, status];
                  update({ verify: next.length > 0 ? next.join(',') : null, view: null });
                }}
                className={cn(
                  'cursor-pointer rounded-md border px-2 py-1 text-xs font-medium transition-colors',
                  active
                    ? 'border-primary bg-primary-subtle text-primary'
                    : 'border-border text-muted-foreground hover:bg-surface-hover hover:text-foreground',
                )}
                title={VERIFICATION_META[status].hint}
              >
                {VERIFICATION_META[status].label}
              </button>
            );
          })}
        </div>

        {/*
          Archived is its own filter rather than a twelfth entry in the stage
          list, because it is a visibility choice and not a position in the
          pipeline: an archived lead still has a stage, and putting it away does
          not make that stage untrue.

          It shows ONLY the archive. "Also show archived" dropped two archived
          leads into seven hundred live ones, which is not a way to look at
          them.
        */}
        <button
          type="button"
          aria-pressed={archivedOnly}
          onClick={() => update({ archived: archivedOnly ? null : '1' })}
          className={cn(
            'cursor-pointer rounded-md border px-2 py-1 text-xs font-medium transition-colors',
            archivedOnly
              ? 'border-primary bg-primary-subtle text-primary'
              : 'border-border text-muted-foreground hover:bg-surface-hover hover:text-foreground',
          )}
          title={archivedOnly ? 'Showing only archived leads. Click to return to the working list.' : 'Show the archive on its own.'}
        >
          <Archive className="size-3" aria-hidden="true" />
          {archivedOnly ? 'Archived only' : 'Archived'}
        </button>

        {/*
          Website is a fact about the LEAD, independent of stage or
          verification — a verified lead can still have no site, and a
          websiteless lead can still be fully worked. So it is its own
          two-way toggle rather than folded into the stage or verification
          filters, and composes with either: pick "Verified" above and
          "No website" here and both apply together, same as any other pair
          of filters on this toolbar.
        */}
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter by website">
          <button
            type="button"
            aria-pressed={hasWebsite === 'yes'}
            onClick={() => update({ website: hasWebsite === 'yes' ? null : 'yes' })}
            className={cn(
              'cursor-pointer rounded-md border px-2 py-1 text-xs font-medium transition-colors',
              hasWebsite === 'yes'
                ? 'border-primary bg-primary-subtle text-primary'
                : 'border-border text-muted-foreground hover:bg-surface-hover hover:text-foreground',
            )}
            title="Only leads with a website on file."
          >
            Has website
          </button>
          <button
            type="button"
            aria-pressed={hasWebsite === 'no'}
            onClick={() => update({ website: hasWebsite === 'no' ? null : 'no' })}
            className={cn(
              'cursor-pointer rounded-md border px-2 py-1 text-xs font-medium transition-colors',
              hasWebsite === 'no'
                ? 'border-primary bg-primary-subtle text-primary'
                : 'border-border text-muted-foreground hover:bg-surface-hover hover:text-foreground',
            )}
            title="Only leads with no website on file."
          >
            No website
          </button>
        </div>

        <div className="flex-1" />

        {/*
          Export is a plain link, not a fetch. The browser's own download
          handling is more reliable than reconstructing a Blob, and it works
          with the filters already in the URL.
        */}
        <a
          href="/api/admin/emails/unverified.csv"
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-surface-hover"
          title="Download every address with no definite verdict, ready for NeverBounce"
        >
          <Download className="size-3.5" aria-hidden="true" />
          Export unverified
        </a>
      </div>

      <ActiveFilters
        stages={stages}
        onRemove={(stage) => {
          const next = stages.filter((s) => s !== stage);
          update({ stage: next.length > 0 ? next.join(',') : null });
        }}
        onClear={() => update({ stage: null, q: null })}
      />

      {/* Bulk action bar appears only with a selection, so it never adds noise. */}
      {selected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary-subtle px-3 py-2">
          <span className="tabular text-sm font-medium text-primary">
            {formatNumber(selected.size)} selected
            {pinnedIds.length > 0 ? (
              <span className="ml-1 font-normal text-muted-foreground">
                ({pinnedIds.length} no longer match this filter — pinned below, marked
                &quot;filtered out&quot;)
              </span>
            ) : null}
          </span>
          <div className="flex-1" />
          {/*
            "Mark invalid" used to sit here setting leads.status = 'invalid'.
            That status meant nothing to the pipeline — whether an address is
            dead is `email_verification_status`, which the verification control
            on the lead page sets — so the button changed a label and no
            behaviour. It is gone rather than reimplemented in bulk.
          */}
          {/*
            Two approvals, and they are NOT the same decision.

            "Approve drafts" is a judgement about the WORDS — it approves the
            active initial draft. "Mark verified" is a verdict about the
            ADDRESS. A lead needs both before it can be sent, and the old single
            "Approve" button read as though it did both, which is how copy gets
            signed off for an address nobody has checked. The labels say which
            is which; the titles say what each one writes.
          */}
          <Button
            size="sm"
            variant="secondary"
            title="Approves the active initial DRAFT — the wording. Does not touch the address."
            onClick={() => runBulk(() => bulkApproveDrafts([...selected]))}
          >
            <CheckCircle2 className="size-3.5" aria-hidden="true" />
            Approve drafts
          </Button>
          <Button
            size="sm"
            variant="secondary"
            title="Marks the ADDRESS verified by hand. Does not touch the draft. Skips leads with no address and ones a verifier proved undeliverable."
            onClick={() => runBulk(() => bulkMarkEmailVerified([...selected]))}
          >
            <MailCheck className="size-3.5" aria-hidden="true" />
            Mark verified
          </Button>
          {editingEmails ? (
            <>
              <Button size="sm" variant="primary" onClick={() => void saveEmails()}>
                <Save className="size-3.5" aria-hidden="true" />
                Save addresses
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEmailEdits(null)}>
                <X className="size-3.5" aria-hidden="true" />
                Cancel
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              title="Type addresses straight into the Email column for the selected rows. Saving sets each one back to never checked."
              onClick={() => setEmailEdits({})}
            >
              <Pencil className="size-3.5" aria-hidden="true" />
              Edit addresses
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={() => setConfirmArchive(true)}>
            <Archive className="size-3.5" aria-hidden="true" />
            Archive
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => setConfirmDelete(true)}
            title="Permanent. Removes the leads and their send history."
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
            Delete
          </Button>
          <Button
            size="sm"
            variant="ghost"
            title="Drops the selection and any unsaved addresses."
            onClick={() => {
              setSelected(new Set());
              setEmailEdits(null);
            }}
          >
            Clear
          </Button>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        <DataTable
          columns={columns}
          rows={displayRows}
          getRowId={(lead) => lead.id}
          resizeStorageKey="leads"
          selectable
          selectedIds={selected}
          onSelectionChange={setSelected}
          sort={sort}
          direction={direction}
          onSortChange={(column, dir) => update({ sort: column, dir })}
          onRowClick={(lead) => router.push(`/leads/${lead.id}`)}
          rowClassName={(lead) =>
            pinnedIds.includes(lead.id)
              ? 'bg-warning-subtle/40 hover:bg-warning-subtle/60'
              : undefined
          }
          emptyState={
            <EmptyState
              icon={Users}
              title={hasFilters ? 'No leads match those filters' : 'No leads yet'}
              description={
                hasFilters
                  ? 'Try a different search term, or clear the stage filters.'
                  : 'Import your workbook with npm run import:leads to populate this table.'
              }
              action={
                hasFilters ? (
                  <Button variant="secondary" onClick={() => update({ q: null, stage: null })}>
                    Clear filters
                  </Button>
                ) : null
              }
            />
          }
        />

        {total > 0 ? (
          <Pagination
            page={page}
            pageSize={pageSize}
            total={total}
            onPageChange={(next) => update({ page: String(next) })}
            onPageSizeChange={(size) => update({ size: String(size), page: '1' })}
          />
        ) : null}
      </div>

      <ConfirmDialog
        open={confirmArchive}
        onOpenChange={setConfirmArchive}
        title={`Archive ${formatNumber(selected.size)} lead${selected.size === 1 ? '' : 's'}?`}
        description="Archived leads are hidden from the working list but not deleted. You can restore them from the lead page, or bring them back into view with Show archived."
        confirmLabel="Archive"
        onConfirm={() => runBulk(() => archiveLeads([...selected]))}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Permanently delete ${formatNumber(selected.size)} lead${selected.size === 1 ? '' : 's'}?`}
        description="This cannot be undone. Their drafts, send history and any replies are deleted with them. Archive instead if you only want them out of the way."
        confirmLabel="Delete permanently"
        destructive
        onConfirm={async () => {
          const result = await deleteLeads([...selected]);
          toast(result.message, result.ok ? 'success' : 'error');
          if (result.ok) {
            setSelected(new Set());
            startTransition(() => router.refresh());
          }
        }}
      />
    </div>
  );
}
