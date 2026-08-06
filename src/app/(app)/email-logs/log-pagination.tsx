'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

import { Pagination } from '@/components/pagination';

/**
 * The paging controls for the email log.
 *
 * A thin client wrapper because `Pagination` takes callbacks and the log page
 * itself is a server component. State lives in the URL, exactly as it does on
 * the leads list, so a particular page of the log is shareable and the back
 * button works.
 *
 * Its absence was the bug: the page has always READ `?page=`, but nothing ever
 * rendered a control to change it, so the log was permanently frozen on the
 * newest 50 rows. On a day when 50 emails went out, that looked precisely like
 * "the log only shows today".
 */
export function LogPagination({
  page,
  pageSize,
  total,
}: {
  page: number;
  pageSize: number;
  total: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [, startTransition] = useTransition();

  const update = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    startTransition(() => router.push(`${pathname}?${next.toString()}`, { scroll: false }));
  };

  return (
    <Pagination
      page={page}
      pageSize={pageSize}
      total={total}
      onPageChange={(next) => update({ page: String(next) })}
      // Changing the page size while on page 7 would land you somewhere
      // arbitrary, so it always returns to the first page.
      onPageSizeChange={(size) => update({ size: String(size), page: '1' })}
    />
  );
}
