'use client';

import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/input';
import { formatNumber } from '@/lib/utils';

export const PAGE_SIZES = [25, 50, 100, 200] as const;

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-3 py-2.5">
      <p className="tabular text-xs text-muted-foreground">
        {total === 0 ? 'No results' : `${formatNumber(from)}–${formatNumber(to)} of ${formatNumber(total)}`}
      </p>

      <div className="flex items-center gap-3">
        {onPageSizeChange ? (
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="hidden sm:inline">Rows</span>
            <Select
              value={pageSize}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
              className="h-7 w-16 px-1.5 text-xs"
              aria-label="Rows per page"
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </Select>
          </label>
        ) : null}

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => onPageChange(1)}
            disabled={page <= 1}
            aria-label="First page"
          >
            <ChevronsLeft className="size-4" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
            aria-label="Previous page"
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
          </Button>

          <span className="tabular px-2 text-xs text-muted-foreground">
            {page} / {pageCount}
          </span>

          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => onPageChange(page + 1)}
            disabled={page >= pageCount}
            aria-label="Next page"
          >
            <ChevronRight className="size-4" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => onPageChange(pageCount)}
            disabled={page >= pageCount}
            aria-label="Last page"
          >
            <ChevronsRight className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  );
}
