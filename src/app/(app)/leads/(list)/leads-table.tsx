'use client';

import * as React from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Users, ExternalLink, Archive, CheckCircle2, Download, Trash2 } from 'lucide-react';

import { DataTable, type Column } from '@/components/data-table';
import { SearchBar } from '@/components/search-bar';
import { FilterPanel, ActiveFilters } from '@/components/filter-panel';
import { Pagination } from '@/components/pagination';
import { EmptyState } from '@/components/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { NextStepBadge, StageBadge } from '@/components/pipeline-badge';
import { archiveLeads, bulkApproveDrafts, deleteLeads } from '@/lib/actions/leads';
import { VERIFICATION_META } from '@/lib/pipeline/labels';
import type { LeadRow } from '@/lib/data/leads';
import {
  EMAIL_VERIFICATION_STATUSES,
  type EmailVerificationStatus,
  type PipelineStage,
} from '@/lib/supabase/database.types';
import { cn, displayUrl, formatDate, formatNumber } from '@/lib/utils';

interface Props {
  rows: LeadRow[];
  total: number;
  page: number;
  pageSize: number;
  search: string;
  stages: PipelineStage[];
  verification: EmailVerificationStatus[];
  showArchived: boolean;
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
  rows, total, page, pageSize, search, stages, verification, showArchived, view, sort, direction, facets,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { toast } = useToast();

  const [pending, startTransition] = React.useTransition();
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [confirmArchive, setConfirmArchive] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

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

  const columns: Column<LeadRow>[] = React.useMemo(
    () => [
      {
        key: 'business_name',
        header: 'Business Name',
        sortable: true,
        width: 240,
        render: (lead) => (
          <Link
            href={`/leads/${lead.id}`}
            onClick={(e) => e.stopPropagation()}
            className="font-medium text-foreground hover:text-primary hover:underline"
          >
            {lead.business_name}
          </Link>
        ),
      },
      {
        key: 'website',
        header: 'Website',
        width: 200,
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
            <span className="text-muted-foreground">{DASH}</span>
          ),
      },
      {
        key: 'email',
        header: 'Email',
        width: 220,
        render: (lead) =>
          lead.email ? (
            <span className="font-mono text-xs">{lead.email}</span>
          ) : (
            <span className="text-muted-foreground">{DASH}</span>
          ),
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
    [],
  );

  async function runBulk(action: () => Promise<{ ok: boolean; message: string }>): Promise<void> {
    const result = await action();
    toast(result.message, result.ok ? 'success' : 'error');
    if (result.ok) {
      setSelected(new Set());
      startTransition(() => router.refresh());
    }
  }

  const hasFilters = search !== '' || stages.length > 0 || verification.length > 0;

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
          Archived is a toggle rather than a twelfth entry in the stage filter,
          because it is a visibility choice and not a position in the pipeline:
          an archived lead still has a stage, and putting it away does not make
          that stage untrue.
        */}
        <button
          type="button"
          aria-pressed={showArchived}
          onClick={() => update({ archived: showArchived ? null : '1' })}
          className={cn(
            'cursor-pointer rounded-md border px-2 py-1 text-xs font-medium transition-colors',
            showArchived
              ? 'border-primary bg-primary-subtle text-primary'
              : 'border-border text-muted-foreground hover:bg-surface-hover hover:text-foreground',
          )}
          title="Archived leads are hidden from the working list by default."
        >
          Show archived
        </button>

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
          </span>
          <div className="flex-1" />
          {/*
            "Mark invalid" used to sit here setting leads.status = 'invalid'.
            That status meant nothing to the pipeline — whether an address is
            dead is `email_verification_status`, which the verification control
            on the lead page sets — so the button changed a label and no
            behaviour. It is gone rather than reimplemented in bulk.
          */}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => runBulk(() => bulkApproveDrafts([...selected]))}
          >
            <CheckCircle2 className="size-3.5" aria-hidden="true" />
            Approve
          </Button>
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
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        <DataTable
          columns={columns}
          rows={rows}
          getRowId={(lead) => lead.id}
          resizeStorageKey="leads"
          selectable
          selectedIds={selected}
          onSelectionChange={setSelected}
          sort={sort}
          direction={direction}
          onSortChange={(column, dir) => update({ sort: column, dir })}
          onRowClick={(lead) => router.push(`/leads/${lead.id}`)}
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
