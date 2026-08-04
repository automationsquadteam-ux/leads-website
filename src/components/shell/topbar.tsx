'use client';

import * as React from 'react';
import { Bell, ChevronDown, LogOut, Menu, Shield, Eye } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { ThemeToggle } from '@/components/theme-toggle';
import { cn, initials } from '@/lib/utils';
import type { AppRole } from '@/lib/supabase/database.types';

export function Topbar({
  email,
  role,
  onOpenNav,
  signOutAction,
}: {
  email: string;
  role: AppRole;
  onOpenNav: () => void;
  signOutAction: () => Promise<void>;
}) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    function onPointerDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <header className="sticky top-0 z-20 flex h-[var(--header-height)] items-center gap-2 border-b border-border bg-surface/85 px-3 backdrop-blur-sm sm:px-4">
      <button
        type="button"
        onClick={onOpenNav}
        aria-label="Open navigation"
        className="cursor-pointer rounded-md p-2 text-muted-foreground hover:bg-surface-hover hover:text-foreground lg:hidden"
      >
        <Menu className="size-4" aria-hidden="true" />
      </button>

      <div className="flex-1" />

      <ThemeToggle />

      {/* Notifications: placeholder surface, disabled so it cannot mislead. */}
      <button
        type="button"
        disabled
        title="Notifications — coming soon"
        aria-label="Notifications (coming soon)"
        className="relative cursor-not-allowed rounded-md p-2 text-muted-foreground opacity-60"
      >
        <Bell className="size-4" aria-hidden="true" />
      </button>

      <div ref={menuRef} className="relative">
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          className="flex cursor-pointer items-center gap-2 rounded-md py-1 pl-1 pr-1.5 hover:bg-surface-hover"
        >
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
            {initials(email)}
          </span>
          <span className="hidden max-w-[160px] truncate text-sm sm:inline">{email}</span>
          <ChevronDown
            className={cn('size-3.5 text-muted-foreground transition-transform', menuOpen && 'rotate-180')}
            aria-hidden="true"
          />
        </button>

        {menuOpen ? (
          <div
            role="menu"
            className="absolute right-0 top-full z-50 mt-1 w-60 overflow-hidden rounded-lg border border-border bg-surface-raised shadow-lg"
          >
            <div className="border-b border-border px-3 py-2.5">
              <p className="truncate text-sm font-medium">{email}</p>
              <div className="mt-1.5">
                <Badge tone={role === 'admin' ? 'primary' : 'neutral'}>
                  {role === 'admin' ? (
                    <Shield className="size-3" aria-hidden="true" />
                  ) : (
                    <Eye className="size-3" aria-hidden="true" />
                  )}
                  {role === 'admin' ? 'Administrator' : 'Viewer (read-only)'}
                </Badge>
              </div>
            </div>
            <form action={signOutAction}>
              <button
                type="submit"
                role="menuitem"
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-2.5 text-left text-sm text-muted-foreground hover:bg-surface-hover hover:text-foreground"
              >
                <LogOut className="size-4" aria-hidden="true" />
                Sign out
              </button>
            </form>
          </div>
        ) : null}
      </div>
    </header>
  );
}
