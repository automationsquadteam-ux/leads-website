import { PublicStatsPage } from './stats-page';

/**
 * The front door.
 *
 * This used to redirect to /dashboard, which meant anyone without an account
 * hit a login form and stopped there. The public statistics ARE the front page
 * now: a visitor sees the pipeline, and signing in is an option rather than a
 * toll gate.
 *
 * `/` is listed in PUBLIC_PATHS in proxy.ts. That matcher compares
 * `pathname === p` for an exact hit, so adding '/' opens this route and nothing
 * beneath it.
 */
export const metadata = {
  title: 'Automation Squad — Outreach Statistics',
  description:
    'Live cold-outreach pipeline statistics: leads researched, emails sent, replies received.',
};

/** Rendered per request: figures from the last deploy are not statistics. */
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  return <PublicStatsPage />;
}
