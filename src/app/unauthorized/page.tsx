import Link from 'next/link';
import { ShieldAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { signOut } from '@/app/login/actions';

export const metadata = { title: 'Not authorised' };

export default function UnauthorizedPage() {
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-md text-center">
        <span className="mx-auto mb-4 grid size-11 place-items-center rounded-xl border border-border bg-muted">
          <ShieldAlert className="size-5 text-muted-foreground" aria-hidden="true" />
        </span>

        <h1 className="text-xl font-semibold tracking-tight">Not authorised</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Your account has read-only access. Lead details, email addresses, research, drafts,
          drafts and settings are restricted to administrators.
        </p>

        <div className="mt-6 flex items-center justify-center gap-2">
          <Link
            href="/dashboard"
            className="inline-flex h-10 cursor-pointer items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
          >
            Go to dashboard
          </Link>
          <form action={signOut}>
            <Button type="submit" variant="secondary" size="lg">
              Sign out
            </Button>
          </form>
        </div>
      </div>
    </main>
  );
}
