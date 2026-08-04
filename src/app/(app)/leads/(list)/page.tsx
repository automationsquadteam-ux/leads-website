import { PageHeader } from '@/components/shell/app-shell';
import { requireAdmin } from '@/lib/auth/session';
import { getLeads, getStatusFacets, isSortColumn, type SortColumn } from '@/lib/data/leads';
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

  const sortParam = single('sort') ?? 'created_at';
  const sort: SortColumn = isSortColumn(sortParam) ? sortParam : 'created_at';
  const direction = single('dir') === 'asc' ? 'asc' : 'desc';

  const pageRaw = Number.parseInt(single('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;

  const sizeRaw = Number.parseInt(single('size') ?? '50', 10);
  const pageSize = PAGE_SIZES.includes(sizeRaw) ? sizeRaw : 50;

  const [result, facets] = await Promise.all([
    getLeads({ search, statuses, sort, direction, page, pageSize }),
    getStatusFacets(),
  ]);

  return (
    <>
      <PageHeader
        title="Leads"
        description={
          result.total > 0
            ? `${formatNumber(result.total)} lead${result.total === 1 ? '' : 's'} matching the current view`
            : 'Search, filter and manage your prospect list'
        }
        actions={<LeadsSyncActions />}
      />

      <div className="p-4 sm:p-6">
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
