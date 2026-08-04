'use client';

import * as React from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';

import { Table, TBody, TD, TH, THead, TR, TableWrap } from '@/components/ui/table';
import { TableSkeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { usePersistedJson } from '@/lib/use-persisted-state';

/** Stable module-level default so the persisted-state fallback never changes identity. */
const EMPTY_WIDTHS: Record<string, number> = {};

/**
 * Resize bounds.
 *
 * MIN is roughly eight characters plus the cell padding narrow enough to
 * squeeze a column almost out of the way when you are looking at something
 * else, wide enough that what remains is still a recognisable value rather
 * than an ellipsis.
 *
 * MAX is generous on purpose: a column should always be draggable wide enough
 * to read the longest value in it, and the longest value here is a business
 * name or an email address.
 */
const MIN_COLUMN_WIDTH = 72;
const MAX_COLUMN_WIDTH = 900;

export interface Column<T> {
  key: string;
  header: string;
  sortable?: boolean;
  /** Initial width in px. Users can drag to resize; widths persist per table. */
  width?: number;
  align?: 'left' | 'right';
  className?: string;
  render: (row: T) => React.ReactNode;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  getRowId: (row: T) => string;
  isLoading?: boolean;
  emptyState?: React.ReactNode;
  /** Row selection */
  selectable?: boolean;
  selectedIds?: Set<string>;
  onSelectionChange?: (ids: Set<string>) => void;
  /** Sorting (controlled by the parent, usually via the URL) */
  sort?: string;
  direction?: 'asc' | 'desc';
  onSortChange?: (column: string, direction: 'asc' | 'desc') => void;
  onRowClick?: (row: T) => void;
  /** localStorage key for persisted column widths. Omit to disable resizing. */
  resizeStorageKey?: string;
}

export function DataTable<T>({
  columns,
  rows,
  getRowId,
  isLoading = false,
  emptyState,
  selectable = false,
  selectedIds,
  onSelectionChange,
  sort,
  direction = 'asc',
  onSortChange,
  onRowClick,
  resizeStorageKey,
}: DataTableProps<T>) {
  // Persisted widths are the source of truth; `dragging` holds the live width
  // mid-gesture so we write to localStorage once on release, not on every move.
  const [savedWidths, setSavedWidths] = usePersistedJson<Record<string, number>>(
    `table-widths:${resizeStorageKey ?? 'none'}`,
    EMPTY_WIDTHS,
  );
  const [dragging, setDragging] = React.useState<{ key: string; width: number } | null>(null);

  const widthFor = (column: Column<T>): number | undefined => {
    if (dragging?.key === column.key) return dragging.width;
    return savedWidths[column.key] ?? column.width;
  };

  /** Drag a column edge. Pointer events cover mouse, pen and touch alike. */
  function startResize(event: React.PointerEvent, key: string, current: number) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    let latest = current;

    function onMove(moveEvent: PointerEvent) {
      const proposed = current + (moveEvent.clientX - startX);
      latest = Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, proposed));
      setDragging({ key, width: latest });
    }
    function onUp() {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      setSavedWidths({ ...savedWidths, [key]: latest });
      setDragging(null);
    }
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  const allIds = rows.map(getRowId);
  const allSelected = selectable && allIds.length > 0 && allIds.every((id) => selectedIds?.has(id));
  const someSelected = selectable && allIds.some((id) => selectedIds?.has(id)) && !allSelected;

  function toggleAll() {
    if (!onSelectionChange) return;
    onSelectionChange(allSelected ? new Set() : new Set(allIds));
  }

  function toggleOne(id: string) {
    if (!onSelectionChange || !selectedIds) return;
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectionChange(next);
  }

  function handleSort(column: Column<T>) {
    if (!column.sortable || !onSortChange) return;
    const nextDirection = sort === column.key && direction === 'asc' ? 'desc' : 'asc';
    onSortChange(column.key, nextDirection);
  }

  if (isLoading) return <TableSkeleton rows={10} columns={columns.length + (selectable ? 1 : 0)} />;
  if (rows.length === 0 && emptyState) return <>{emptyState}</>;

  return (
    <TableWrap>
      <Table>
        <THead>
          <tr>
            {selectable ? (
              <TH className="w-10">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected;
                  }}
                  onChange={toggleAll}
                  aria-label="Select all rows on this page"
                  className="size-3.5 cursor-pointer accent-primary"
                />
              </TH>
            ) : null}

            {columns.map((column) => {
              const active = sort === column.key;
              const width = widthFor(column);
              return (
                <TH
                  key={column.key}
                  // Under table-fixed a single `width` is authoritative. Pinning
                  // minWidth to the same value (as this used to) re-introduced
                  // the floor that made narrowing impossible.
                  style={width ? { width } : undefined}
                  // aria-sort communicates the current sort to screen readers.
                  aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : undefined}
                  className={cn('group relative', column.align === 'right' && 'text-right')}
                >
                  {column.sortable && onSortChange ? (
                    <button
                      type="button"
                      onClick={() => handleSort(column)}
                      className={cn(
                        'inline-flex cursor-pointer items-center gap-1 rounded transition-colors hover:text-foreground',
                        active && 'text-foreground',
                      )}
                    >
                      {column.header}
                      {active ? (
                        direction === 'asc' ? (
                          <ArrowUp className="size-3" aria-hidden="true" />
                        ) : (
                          <ArrowDown className="size-3" aria-hidden="true" />
                        )
                      ) : (
                        <ChevronsUpDown
                          className="size-3 opacity-0 transition-opacity group-hover:opacity-50"
                          aria-hidden="true"
                        />
                      )}
                    </button>
                  ) : (
                    column.header
                  )}

                  {resizeStorageKey ? (
                    <span
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={`Resize ${column.header} column`}
                      onPointerDown={(e) => startResize(e, column.key, width ?? 160)}
                      onDoubleClick={() => {
                        // Double-click resets the column to its default width.
                        const next = { ...savedWidths };
                        delete next[column.key];
                        setSavedWidths(next);
                      }}
                      className="absolute right-0 top-0 h-full w-1 cursor-col-resize touch-none select-none bg-transparent hover:bg-primary/40"
                    />
                  ) : null}
                </TH>
              );
            })}
          </tr>
        </THead>

        <TBody>
          {rows.map((row) => {
            const id = getRowId(row);
            const selected = selectedIds?.has(id) ?? false;
            return (
              <TR
                key={id}
                data-selected={selected}
                className={onRowClick ? 'cursor-pointer' : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {selectable ? (
                  <TD onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => toggleOne(id)}
                      aria-label={`Select row ${id}`}
                      className="size-3.5 cursor-pointer accent-primary"
                    />
                  </TD>
                ) : null}
                {columns.map((column) => (
                  <TD
                    key={column.key}
                    className={cn(column.align === 'right' && 'text-right', column.className)}
                  >
                    {column.render(row)}
                  </TD>
                ))}
              </TR>
            );
          })}
        </TBody>
      </Table>
    </TableWrap>
  );
}
