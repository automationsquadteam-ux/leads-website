import { NextResponse, type NextRequest } from 'next/server';

import { readSession } from '@/lib/supabase/middleware';

/**
 * Route protection middleware.
 *
 * This is Next.js middleware. Next 16 renamed the file convention from
 * `middleware.ts` / `export function middleware` to `proxy.ts` /
 * `export function proxy` same edge-runtime hook, same `config.matcher`,
 * new name. Using the old name still works but logs a deprecation warning.
 *
 * Three tiers:
 *   public  /login and the auth callback
 *   signed-in dashboards, open to admin and viewer
 *   admin   everything under ADMIN_PREFIXES
 *
 * This is the first line of defence, not the only one. Pages and Server Actions
 * still call requireAdmin()/assertAdmin(), and RLS is the backstop underneath
 * both: a viewer who forges their way to /admin/leads still gets zero rows.
 */

/**
 * Routes reachable while signed out.
 *
 *   /           the public front page. Reads only the anon-granted
 *               public_stats_* views aggregates, plus an opt-in lead list
 *               that is empty unless an admin enabled it.
 *   /stats      legacy alias, redirects to /.
 *   /api/cron   scheduled endpoints. No session exists for a cron caller, so
 *               they authenticate with the CRON_SECRET bearer token themselves.
 *               Listing them here skips the login redirect, NOT the auth check.
 *   /api/inbound  the Cloudflare Email Worker posts here. Same deal: no
 *               session, bearer token checked inside the route.
 *
 * isPublic() matches `pathname === p` or `pathname.startsWith(p + '/')`. For
 * '/' the second test is `startsWith('//')`, which never fires so this opens
 * the front page exactly, not the whole site.
 */
const PUBLIC_PATHS = ['/', '/login', '/auth/callback', '/stats', '/api/cron', '/api/inbound'];

/**
 * Everything below these prefixes requires role = 'admin'.
 * Add a prefix here whenever you add an admin route.
 */
const ADMIN_PREFIXES = [
  '/leads',
  '/email-logs',
  '/send-failures',
  '/email-schedule',
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

  /*
   * A public route that needs nothing from the session does not touch auth.
   *
   * This used to call readSession() FIRST and check isPublic() afterwards, so
   * every hit on the public front page made two blocking Supabase calls whose
   * answer was then thrown away. That is wasteful on a good day and fatal on a
   * bad one: on 2026-08-28 this project's auth service stopped responding while
   * the database stayed healthy, and because the front page still waited on it,
   * the whole site answered 504 MIDDLEWARE_INVOCATION_TIMEOUT ,including a
   * page that reads nothing but anon-granted aggregate views and has no concept
   * of a user.
   *
   * `/login` is deliberately NOT in this set: it needs to know whether someone
   * is already signed in so it can bounce them to /dashboard. It still degrades
   * safely, because readSession() now fails closed rather than hanging.
   *
   * The cron and inbound routes are here for the same reason ,they carry a
   * bearer token and check it themselves, so a session lookup for them is pure
   * latency on a path that must not depend on auth being up.
   */
  const needsSession = pathname === '/login' || !isPublic(pathname);
  if (!needsSession) return NextResponse.next();

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
   * match /unauthorized and /dashboard both need a session check.
   */
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff|woff2|ttf)$).*)',
  ],
};
