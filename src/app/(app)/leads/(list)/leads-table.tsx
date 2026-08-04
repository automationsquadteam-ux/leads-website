'use client';

import * as React from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Users, ExternalLink, Archive, CheckCircle2, Ban } from 'lucide-react';

import { DataTable, type Column } from '@/components/data-table';
import { SearchBar } from '@/components/search-bar';
import { FilterPanel, ActiveFilters } from '@/components/filter-panel';
import { Pagination } from '@/components/pagination';
import { EmptyState } from '@/components/empty-state';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { NextStepBadge, StageBadge } from '@/components/pipeline-badge';
import { bulkSetStatus } from '@/lib/actions/leads';
import type { LeadRow } from '@/lib/data/leads';
import type { LeadStatus } from '@/lib/supabase/database.types';
import { displayUrl, formatDate, formatNumber } from '@/lib/utils';

interface Props {
  rows: LeadRow[];
  total: number;
  page: number;
  pageSize: number;
  search: string;
  statuses: LeadStatus[];
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
  rows, total, page, pageSize, search, statuses, sort, direction, facets,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { toast } = useToast();

  const [pending, startTransition] = React.useTransition();
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [confirmArchive, setConfirmArchive] = React.useState(false);

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
        key: 'category',
        header: 'Category',
        sortable: true,
        width: 150,
        render: (lead) => <span className="text-muted-foreground">{lead.category ?? DASH}</span>,
      },
      {
        key: 'status',
        header: 'Status',
        sortable: true,
        width: 130,
        render: (lead) => <StatusBadge status={lead.status} />,
      },
      // Stage and next step are the two figures that decide what to do with a
      // lead, so they belong in the list, not only on the detail page. Both are
      // derived in Postgres; a null means the pipeline row has not been created
      // yet, which happens only for rows written before migration 0012.
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

  async function runBulk(status: LeadStatus): Promise<void> {
    const result = await bulkSetStatus([...selected], status);
    toast(result.message, result.ok ? 'success' : 'error');
    if (result.ok) {
      setSelected(new Set());
      startTransition(() => router.refresh());
    }
  }

  const hasFilters = search !== '' || statuses.length > 0;

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
          selected={statuses}
          facets={facets}
          onChange={(next) => update({ status: next.length > 0 ? next.join(',') : null })}
        />
      </div>

      <ActiveFilters
        statuses={statuses}
        onRemove={(status) => {
          const next = statuses.filter((s) => s !== status);
          update({ status: next.length > 0 ? next.join(',') : null });
        }}
        onClear={() => update({ status: null, q: null })}
      />

      {/* Bulk action bar appears only with a selection, so it never adds noise. */}
      {selected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary-subtle px-3 py-2">
          <span className="tabular text-sm font-medium text-primary">
            {formatNumber(selected.size)} selected
          </span>
          <div className="flex-1" />
          <Button size="sm" variant="secondary" onClick={() => runBulk('approved')}>
            <CheckCircle2 className="size-3.5" aria-hidden="true" />
            Approve
          </Button>
          <Button size="sm" variant="secondary" onClick={() => runBulk('invalid')}>
            <Ban className="size-3.5" aria-hidden="true" />
            Mark invalid
          </Button>
          <Button size="sm" variant="danger" onClick={() => setConfirmArchive(true)}>
            <Archive className="size-3.5" aria-hidden="true" />
            Archive
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
                  ? 'Try a different search term, or clear the status filters.'
                  : 'Import your workbook with npm run import:leads to populate this table.'
              }
              action={
                hasFilters ? (
                  <Button variant="secondary" onClick={() => update({ q: null, status: null })}>
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
        description="Archived leads are hidden from the working pipeline but not deleted. You can restore them from the lead page."
        confirmLabel="Archive"
        destructive
        onConfirm={() => runBulk('archived')}
      />
    </div>
  );
}
