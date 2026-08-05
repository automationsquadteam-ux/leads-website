import {
  LayoutDashboard, Users, Mail, MessageSquare, Settings, BarChart3, Globe,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type { AppRole } from '@/lib/supabase/database.types';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Roles allowed to see AND reach this destination. */
  roles: AppRole[];
}

/**
 * Single source of truth for navigation.
 *
 * `roles` here only controls what is rendered. It is not a security boundary —
 * middleware (src/proxy.ts) blocks the routes, each page calls requireAdmin(),
 * and RLS denies the rows. Hiding a link is a courtesy, never a lock.
 */
export const NAV_ITEMS: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, roles: ['admin', 'viewer'] },
  { href: '/leads', label: 'Leads', icon: Users, roles: ['admin'] },
  { href: '/analytics', label: 'Analytics', icon: BarChart3, roles: ['admin'] },
  { href: '/email-logs', label: 'Email Logs', icon: Mail, roles: ['admin'] },
  { href: '/replies', label: 'Replies', icon: MessageSquare, roles: ['admin'] },
  // The public front page. Shown to both roles because it is the one
  // destination a viewer can genuinely use it needs no session at all.
  { href: '/', label: 'Public Page', icon: Globe, roles: ['admin', 'viewer'] },
  { href: '/settings', label: 'Settings', icon: Settings, roles: ['admin'] },
];

export function navItemsForRole(role: AppRole): NavItem[] {
  return NAV_ITEMS.filter((item) => item.roles.includes(role));
}
