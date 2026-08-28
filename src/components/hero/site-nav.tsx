'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Menu, X } from 'lucide-react';

import { BrandMark } from '@/components/brand';
import { ThemeToggle } from '@/components/theme-toggle';

export interface NavLink {
  label: string;
  href: string;
}

/**
 * The public header: wordmark, four links, and a full-screen mobile menu.
 *
 * The links are the real destinations in this app rather than the spec's
 * placeholder set ,a nav whose items 404 is worse than no nav, and this is a
 * CRM, not a portfolio site. The treatment (Inter, uppercase, mint on hover)
 * is the spec's.
 *
 * Two details the overlay needs to not feel broken:
 *
 * - Body scroll is locked while it is open, or the page behind scrolls under
 *   the fixed panel and the menu appears to drift.
 * - Escape closes it, and the toggle carries `aria-expanded`. A menu that can
 *   only be dismissed by hitting the same small target again is a trap for
 *   keyboard users.
 */
export function SiteNav({ links, signInHref = '/login' }: { links: NavLink[]; signInHref?: string }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;

    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);

    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <header className="absolute inset-x-0 top-0 z-30">
      <nav className="mx-auto flex max-w-7xl items-center justify-between px-5 py-5 sm:px-8">
        <Link href="/" className="flex items-center gap-2.5" aria-label="Automation Squad, home">
          <BrandMark size={30} className="rounded-md" priority />
          <span className="min-w-0">
            <span className="font-display block text-[15px] font-bold tracking-tight text-white">
              Automation <span className="text-primary">Squad</span>
            </span>
            <span className="font-display block text-[10px] font-semibold tracking-[0.14em] text-white/50 uppercase">
              Outreach statistics
            </span>
          </span>
        </Link>

        <div className="hidden items-center gap-8 md:flex">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-[16px] font-medium tracking-wide text-white/80 uppercase transition-colors hover:text-primary"
            >
              {link.label}
            </Link>
          ))}
          <ThemeToggle />
          <Link
            href={signInHref}
            className="rounded-full bg-primary px-5 py-2 text-[13px] font-bold tracking-wide text-primary-foreground uppercase transition-colors hover:bg-primary-hover"
          >
            Sign in
          </Link>
        </div>

        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-white md:hidden"
          aria-label="Open menu"
          aria-expanded={open}
        >
          <Menu className="size-6" aria-hidden="true" />
        </button>
      </nav>

      {open ? (
        <div className="fixed inset-0 z-40 flex flex-col bg-[#070b0a] md:hidden">
          <div className="flex items-center justify-between px-5 py-5">
            <span className="font-display text-[15px] font-bold tracking-tight text-white">
              Automation <span className="text-primary">Squad</span>
            </span>
            <div className="flex items-center gap-2">
              <ThemeToggle />
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-white"
                aria-label="Close menu"
              >
                <X className="size-6" aria-hidden="true" />
              </button>
            </div>
          </div>

          <div className="flex flex-1 flex-col justify-center gap-2 px-5 pb-24">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setOpen(false)}
                className="border-b border-white/10 py-4 text-2xl font-bold tracking-tight text-white uppercase transition-colors hover:text-primary"
              >
                {link.label}
              </Link>
            ))}
            <Link
              href={signInHref}
              onClick={() => setOpen(false)}
              className="mt-6 rounded-full bg-primary px-6 py-3.5 text-center text-sm font-bold tracking-wide text-primary-foreground uppercase"
            >
              Sign in
            </Link>
          </div>
        </div>
      ) : null}
    </header>
  );
}
