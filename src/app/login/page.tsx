import { BrandMark } from '@/components/brand';
import { CenterGlow, GridLines } from '@/components/hero/atmosphere';
import { LoginForm } from './login-form';

export const metadata = { title: 'Sign in' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return (
    /*
     * The glow and grid appear here too ,this is the only other page a
     * signed-out visitor sees, so it carries the landing page's atmosphere
     * rather than dropping straight into the flat admin surface. No video: a
     * sign-in form is a task, and a moving backdrop behind a password field is
     * a distraction rather than a welcome.
     */
    <main className="relative grid min-h-dvh place-items-center overflow-hidden px-4 py-10">
      <CenterGlow className="top-[-6%] left-1/2 h-[420px] w-[150%] -translate-x-1/2 opacity-60" />
      <GridLines />

      <div className="relative z-10 w-full max-w-sm">
        <div className="mb-7 flex flex-col items-center text-center">
          {/* The largest thing on this page, so it is worth prioritising. */}
          <BrandMark size={56} className="mb-4 rounded-xl shadow-sm" priority />
          <h1 className="text-2xl font-extrabold tracking-tight">
            Sign in to Automation <span className="text-primary">Squad</span>
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Accounts are provisioned by an administrator.
          </p>
        </div>

        <div className="glass glass-frame rounded-2xl p-5">
          <LoginForm next={next} />
        </div>
      </div>
    </main>
  );
}
