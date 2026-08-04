import { TableSkeleton, Skeleton } from '@/components/ui/skeleton';

export default function LeadsLoading() {
  return (
    <>
      <div className="border-b border-border px-4 py-4 sm:px-6">
        <Skeleton className="h-6 w-28" />
        <Skeleton className="mt-2 h-4 w-64" />
      </div>
      <div className="space-y-3 p-4 sm:p-6">
        <div className="flex gap-2">
          <Skeleton className="h-9 flex-1" />
          <Skeleton className="h-9 w-24" />
        </div>
        <div className="overflow-hidden rounded-lg border border-border bg-surface">
          <TableSkeleton rows={12} columns={8} />
        </div>
      </div>
    </>
  );
}
