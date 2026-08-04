import { NextResponse, type NextRequest } from 'next/server';

import { readSession } from '@/lib/supabase/middleware';

/**
 * Route protection middleware.
 *
 * This is Next.js middleware. Next 16 renamed the file convention from
 * `middleware.ts` / `export function middleware` to `proxy.ts` /
 * `export function proxy` — same edge-runtime hook, same `config.matcher`,
 * new name. Using the old name still works but logs a deprecation warning.
 *
 * Three tiers:
 *   public  — /login and the auth callback
 *   signed-in — dashboards, open to admin and viewer
 *   admin   — everything under ADMIN_PREFIXES
 *
 * This is the first line of defence, not the only one. Pages and Server Actions
 * still call requireAdmin()/assertAdmin(), and RLS is the backstop underneath
 * both: a viewer who forges their way to /admin/leads still gets zero rows.
 */

/**
 * Routes reachable while signed out.
 *
 *   /           the public front page. Reads only the anon-granted
 *               public_stats_* views — aggregates, plus an opt-in lead list
 *               that is empty unless an admin enabled it.
 *   /stats      legacy alias, redirects to /.
 *   /api/cron   scheduled endpoints. No session exists for a cron caller, so
 *               they authenticate with the CRON_SECRET bearer token themselves.
 *               Listing them here skips the login redirect, NOT the auth check.
 *
 * isPublic() matches `pathname === p` or `pathname.startsWith(p + '/')`. For
 * '/' the second test is `startsWith('//')`, which never fires — so this opens
 * the front page exactly, not the whole site.
 */
const PUBLIC_PATHS = ['/', '/login', '/auth/callback', '/stats', '/api/cron'];

/**
 * Everything below these prefixes requires role = 'admin'.
 * Add a prefix here whenever you add an admin route.
 */
const ADMIN_PREFIXES = [
  '/leads',
  '/campaigns',
  '/templates',
  '/email-logs',
  '/replies',
  '/settings',
  '/analytics',
  '/import',
  '/api/admin',
];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function isAdminRoute(pathname: string): boolean {
  return ADMIN_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  const { response, userId, role } = await readSession(request);

  // Signed-in users have no business on the login page.
  if (userId && pathname === '/login') {
    return NextResponse.redirect(new URL('/dashboard', request.url));
  }

  if (isPublic(pathname)) return response;

  if (!userId) {
    const loginUrl = new URL('/login', request.url);
    // Preserve the destination so login can send them back after signing in.
    loginUrl.searchParams.set('next', `${pathname}${search}`);
    return NextResponse.redirect(loginUrl);
  }

  // Authenticated but no profile row => no role => authorize nothing.
  if (!role) {
    return NextResponse.redirect(new URL('/unauthorized', request.url));
  }

  if (isAdminRoute(pathname) && role !== 'admin') {
    return NextResponse.redirect(new URL('/unauthorized', request.url));
  }

  return response;
}

export const config = {
  /**
   * Run on everything except static assets and image files. Note this WILL
   * match /unauthorized and /dashboard — both need a session check.
   */
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff|woff2|ttf)$).*)',
  ],
};
