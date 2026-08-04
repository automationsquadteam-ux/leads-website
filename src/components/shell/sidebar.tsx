'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { X } from 'lucide-react';

import { BrandMark } from '@/components/brand';
import { cn } from '@/lib/utils';
import type { AppRole } from '@/lib/supabase/database.types';
import { navItemsForRole } from './nav-config';

export function SidebarNav({ role, onNavigate }: { role: AppRole; onNavigate?: () => void }) {
  const pathname = usePathname();
  const items = navItemsForRole(role);

  return (
    <nav aria-label="Main" className="flex-1 space-y-0.5 px-2 py-3">
      {items.map(({ href, label, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            // aria-current is what tells a screen reader "you are here";
            // the colour change alone would not.
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors',
              active
                ? 'bg-primary-subtle font-medium text-primary'
                : 'text-muted-foreground hover:bg-surface-hover hover:text-foreground',
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden="true" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

export function SidebarBrand() {
  return (
    <Link
      href="/dashboard"
      className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border px-4"
    >
      <BrandMark size={28} />
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold tracking-tight">Automation Squad</span>
        <span className="block text-[11px] text-muted-foreground">Leads CRM</span>
      </span>
    </Link>
  );
}

/** Desktop rail — fixed at the density-scale width of 240px. */
export function DesktopSidebar({ role }: { role: AppRole }) {
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-[var(--sidebar-width)] flex-col border-r border-border bg-surface lg:flex">
      <SidebarBrand />
      <SidebarNav role={role} />
      <p className="border-t border-border px-4 py-3 text-[11px] text-muted-foreground">
        Signed in as <span className="font-medium text-foreground">{role}</span>
      </p>
    </aside>
  );
}

/** Mobile drawer. Sidebar is secondary navigation, so a drawer is the right pattern. */
export function MobileSidebar({
  role,
  open,
  onClose,
}: {
  role: AppRole;
  open: boolean;
  onClose: () => void;
}) {
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    if (open) document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="lg:hidden">
      <div
        className="fixed inset-0 z-40 bg-black/50"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        className="fixed inset-y-0 left-0 z-50 flex w-[var(--sidebar-width)] flex-col border-r border-border bg-surface"
      >
        <div className="flex items-center justify-between border-b border-border pr-2">
          <SidebarBrand />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            className="cursor-pointer rounded-md p-2 text-muted-foreground hover:bg-surface-hover hover:text-foreground"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
        <SidebarNav role={role} onNavigate={onClose} />
      </aside>
    </div>
  );
}
