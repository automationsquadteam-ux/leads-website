import { BrandMark } from '@/components/brand';
import { LoginForm } from './login-form';

export const metadata = { title: 'Sign in' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-7 flex flex-col items-center text-center">
          {/* The largest thing on this page, so it is worth prioritising. */}
          <BrandMark size={56} className="mb-3 rounded-xl shadow-sm" priority />
          <h1 className="text-xl font-semibold tracking-tight">Sign in to Automation Squad</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Accounts are provisioned by an administrator.
          </p>
        </div>

        <div className="rounded-xl border border-border bg-surface p-5 shadow-sm">
          <LoginForm next={next} />
        </div>
      </div>
    </main>
  );
}
