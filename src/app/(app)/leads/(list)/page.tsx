import Link from 'next/link';
import { X } from 'lucide-react';

import { PageHeader } from '@/components/shell/app-shell';
import { Badge } from '@/components/ui/badge';
import { requireAdmin } from '@/lib/auth/session';
import {
  getLeads, getStatusFacets, isLeadView, isSortColumn,
  LEAD_VIEWS, type SortColumn,
} from '@/lib/data/leads';
import { LEAD_STATUSES, type LeadStatus } from '@/lib/supabase/database.types';
import { formatNumber } from '@/lib/utils';
import { LeadsTable } from './leads-table';
import { LeadsSyncActions } from './sync-actions';

export const metadata = { title: 'Leads' };

const PAGE_SIZES = [25, 50, 100, 200];

function parseStatuses(raw: string | undefined): LeadStatus[] {
  if (!raw) return [];
  const allowed = new Set<string>(LEAD_STATUSES);
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is LeadStatus => allowed.has(s));
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Admin-only: viewers never reach lead detail, email addresses or drafts.
  await requireAdmin();

  const params = await searchParams;
  const single = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const search = single('q') ?? '';
  const statuses = parseStatuses(single('status'));

  // ?view=<name> is how every dashboard widget drills through. Unknown values
  // are ignored rather than erroring — a stale bookmark should show the full
  // list, not a crash.
  const viewParam = single('view');
  const view = viewParam && isLeadView(viewParam) ? viewParam : undefined;

  const sortParam = single('sort') ?? 'created_at';
  const sort: SortColumn = isSortColumn(sortParam) ? sortParam : 'created_at';
  const direction = single('dir') === 'asc' ? 'asc' : 'desc';

  const pageRaw = Number.parseInt(single('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;

  const sizeRaw = Number.parseInt(single('size') ?? '50', 10);
  const pageSize = PAGE_SIZES.includes(sizeRaw) ? sizeRaw : 50;

  const [result, facets] = await Promise.all([
    getLeads({ search, statuses, view, sort, direction, page, pageSize }),
    getStatusFacets(),
  ]);

  return (
    <>
      <PageHeader
        title={view ? LEAD_VIEWS[view] : 'Leads'}
        description={
          result.total > 0
            ? `${formatNumber(result.total)} lead${result.total === 1 ? '' : 's'} matching the current view`
            : 'Search, filter and manage your prospect list'
        }
        actions={<LeadsSyncActions />}
      />

      <div className="p-4 sm:p-6">
        {/*
          A drilled-in view is not obvious from the table alone, so it gets a
          dismissible chip. Without it, "why am I only seeing 114 leads?" is a
          support question.
        */}
        {view ? (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Badge tone="primary">{LEAD_VIEWS[view]}</Badge>
            <Link
              href="/leads"
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-surface-hover hover:text-foreground"
            >
              <X className="size-3" aria-hidden="true" />
              Clear view
            </Link>
          </div>
        ) : null}

        {result.error ? (
          <p className="mb-3 rounded-md border border-danger/30 bg-danger-subtle px-3 py-2.5 text-sm text-danger">
            Could not load leads: {result.error}
          </p>
        ) : null}

        <LeadsTable
          rows={result.rows}
          total={result.total}
          page={page}
          pageSize={pageSize}
          search={search}
          statuses={statuses}
          sort={sort}
          direction={direction}
          facets={facets}
        />
      </div>
    </>
  );
}
