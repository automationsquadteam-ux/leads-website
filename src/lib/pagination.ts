/**
 * Page sizes, in a PLAIN module on purpose.
 *
 * This constant used to live in `components/pagination.tsx`, which carries
 * `'use client'`. A server component importing a non-component value from a
 * client module does not get the value — it gets a client REFERENCE — so
 * `PAGE_SIZES.includes(...)` threw "is not a function" at request time, and only
 * at request time: `next build` never noticed, because the page that used it is
 * dynamic and is therefore never rendered during the build.
 *
 * This is the mirror image of the `'use server'` trap in section 6 of GUIDE.md.
 * Same rule, both directions: **a value shared across the client/server boundary
 * belongs in a module with no directive at all**, imported by both sides. Types
 * are exempt — they are erased before any of this matters.
 */
export const PAGE_SIZES = [25, 50, 100, 200] as const;

export type PageSize = (typeof PAGE_SIZES)[number];

/** Clamp a `?size=` query parameter to something we actually offer. */
export function parsePageSize(raw: string | undefined, fallback: PageSize = 50): PageSize {
  const parsed = Number.parseInt(raw ?? '', 10);
  return (PAGE_SIZES as readonly number[]).includes(parsed) ? (parsed as PageSize) : fallback;
}

/** Clamp a `?page=` query parameter to a positive integer. */
export function parsePageNumber(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}
