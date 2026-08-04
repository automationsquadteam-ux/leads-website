import { redirect } from 'next/navigation';
import type { User } from '@supabase/supabase-js';

import { createClient } from '@/lib/supabase/server';
import type { AppRole, Profile } from '@/lib/supabase/database.types';

export interface SessionContext {
  user: User;
  profile: Profile;
  role: AppRole;
  isAdmin: boolean;
}

/**
 * Current user + profile, or null when signed out.
 *
 * Always uses `getUser()` rather than `getSession()`: getUser revalidates the
 * JWT with the auth server, so a forged or stale cookie cannot fake a session.
 */
export async function getSessionContext(): Promise<SessionContext | null> {
  const supabase = await createClient();

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) return null;

  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();

  // A user without a profile row has no role, so it cannot be authorized for
  // anything. Fail closed rather than inventing a default.
  if (!profile) return null;

  return {
    user,
    profile,
    role: profile.role,
    isAdmin: profile.role === 'admin',
  };
}

/** Require a signed-in user; otherwise bounce to /login. */
export async function requireUser(redirectTo = '/login'): Promise<SessionContext> {
  const context = await getSessionContext();
  if (!context) redirect(redirectTo);
  return context;
}

/**
 * Require an admin.
 *
 * Middleware already blocks admin routes, but this is the check that actually
 * matters — middleware can be bypassed by any code path that does not run it
 * (Server Actions invoked directly, Route Handlers outside the matcher). Call
 * this at the top of every admin page, action and handler.
 */
export async function requireAdmin(): Promise<SessionContext> {
  const context = await requireUser();
  if (!context.isAdmin) redirect('/unauthorized');
  return context;
}

/** Non-redirecting variant for Server Actions that return an error instead. */
export async function assertAdmin(): Promise<SessionContext> {
  const context = await getSessionContext();
  if (!context) throw new Error('Not authenticated');
  if (!context.isAdmin) throw new Error('Forbidden: admin role required');
  return context;
}
