import { AppShell } from '@/components/shell/app-shell';
import { RealtimeRefresh } from '@/components/realtime-refresh';
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
      {/*
        Admins only. Every published table's RLS is
        `for select to authenticated using (public.is_admin())`, so a viewer's
        subscription would receive nothing anyway — this just avoids opening a
        websocket to be told nothing, and keeps the intent visible in the code
        rather than only in the policies.
      */}
      {role === 'admin' ? <RealtimeRefresh /> : null}
      {children}
    </AppShell>
  );
}
