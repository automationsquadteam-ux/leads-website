'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { createClient } from '@/lib/supabase/server';

export interface LoginState {
  error: string | null;
}

const credentials = z.object({
  email: z.email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your password.'),
  next: z.string().optional(),
});

/** Only allow same-origin relative paths, so `?next=` cannot become an open redirect. */
function safeNext(value: string | undefined): string | null {
  if (!value) return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  return value;
}

export async function signIn(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = credentials.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
    next: formData.get('next') ?? undefined,
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid credentials.' };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (error || !data.user) {
    // Deliberately vague: do not reveal whether the address exists.
    return { error: 'Incorrect email or password.' };
  }

  revalidatePath('/', 'layout');

  // redirect() throws internally, so it must sit outside any try/catch.
  // Both roles land on /dashboard; the shell adapts its nav to the role.
  redirect(safeNext(parsed.data.next) ?? '/dashboard');
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  revalidatePath('/', 'layout');
  redirect('/login');
}
