import { AppShell } from '@/components/shell/app-shell';
import { signOut } from '@/app/login/actions';
import { requireUser } from '@/lib/auth/session';

/**
 * Authenticated shell. Every route in this group is behind a session check —
 * middleware redirects anonymous requests, and requireUser() here is the
 * server-side guarantee for anything middleware might not cover.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, role } = await requireUser();

  return (
    <AppShell email={user.email ?? 'Unknown user'} role={role} signOutAction={signOut}>
      {children}
    </AppShell>
  );
}
