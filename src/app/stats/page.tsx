import { redirect } from 'next/navigation';

/**
 * `/stats` predates the public front page and is kept as a permanent redirect
 * so existing links, the sidebar entry and any bookmark keep working.
 */
export default function StatsRedirect() {
  redirect('/');
}
