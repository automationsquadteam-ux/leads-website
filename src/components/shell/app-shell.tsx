'use client';

import * as React from 'react';

import { ToastProvider } from '@/components/ui/toast';
import type { AppRole } from '@/lib/supabase/database.types';
import { DesktopSidebar, MobileSidebar } from './sidebar';
import { Topbar } from './topbar';

export function AppShell({
  email,
  role,
  signOutAction,
  children,
}: {
  email: string;
  role: AppRole;
  signOutAction: () => Promise<void>;
  children: React.ReactNode;
}) {
  const [navOpen, setNavOpen] = React.useState(false);

  return (
    <ToastProvider>
      {/* Skip link: first tab stop, so keyboard users can jump past the nav. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-[100] focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:text-primary-foreground"
      >
        Skip to main content
      </a>

      <DesktopSidebar role={role} />
      <MobileSidebar role={role} open={navOpen} onClose={() => setNavOpen(false)} />

      {/*
        `min-w-0` is the load-bearing class here, not `overflow-x-hidden`.
        A grid or flex child defaults to `min-width: auto`, meaning it refuses to
        shrink below its widest CONTENT ,so one long unbreakable string (a curl
        command, an email address, a URL) silently widened this column, which
        widened the page, which is why every screen could be dragged sideways
        into blank space on a phone while the content itself had gone one-column.
        Clipping alone would have hidden the symptom and kept the layout wrong.
      */}
      <div className="min-w-0 lg:pl-[var(--sidebar-width)]">
        <Topbar
          email={email}
          role={role}
          onOpenNav={() => setNavOpen(true)}
          signOutAction={signOutAction}
        />
        <main
          id="main"
          tabIndex={-1}
          className="min-h-[calc(100dvh-var(--header-height))] overflow-x-hidden"
        >
          {children}
        </main>
      </div>
    </ToastProvider>
  );
}

/** Consistent page header used by every route. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-4 sm:px-6">
      <div className="min-w-0">
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        {description ? (
          <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
