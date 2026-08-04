'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, CheckCircle2, Loader2, type LucideIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/toast';
import { cn, formatRelative } from '@/lib/utils';
import type { IntegrationRunStatus } from '@/lib/supabase/database.types';

export interface LastRun {
  status: IntegrationRunStatus;
  message: string | null;
  startedAt: string;
  durationMs: number | null;
}

/**
 * Trigger button with persistent run state.
 *
 * The status shown after a reload comes from integration_runs in the database,
 * not component state — so "last run" survives navigation, and a run started in
 * another tab (or by a future scheduled job) is still reflected here.
 */
export function TriggerButton({
  label,
  icon: Icon,
  description,
  lastRun,
  action,
  variant = 'primary',
  confirmLabel,
}: {
  label: string;
  icon?: LucideIcon;
  description?: string;
  lastRun?: LastRun | null;
  action: () => Promise<{ ok: boolean; message: string }>;
  variant?: 'primary' | 'secondary';
  confirmLabel?: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [running, setRunning] = React.useState(false);
  const [result, setResult] = React.useState<{ ok: boolean; message: string } | null>(null);

  async function run() {
    if (confirmLabel && !window.confirm(confirmLabel)) return;

    setRunning(true);
    setResult(null);
    try {
      const outcome = await action();
      setResult(outcome);
      toast(outcome.message, outcome.ok ? 'success' : 'error');
      router.refresh();
    } catch (error) {
      // A thrown error here means the action itself failed to reach the server
      // (network drop, deploy mid-request) rather than the integration failing.
      const message =
        error instanceof Error
          ? `Could not reach the server: ${error.message}`
          : 'Could not reach the server.';
      setResult({ ok: false, message });
      toast(message, 'error');
    } finally {
      setRunning(false);
    }
  }

  // Live result wins over the persisted one until the router refresh lands.
  const shown: { status: IntegrationRunStatus; message: string | null; at: string | null } | null =
    running
      ? { status: 'running', message: 'Running…', at: null }
      : result
        ? { status: result.ok ? 'success' : 'failed', message: result.message, at: null }
        : lastRun
          ? { status: lastRun.status, message: lastRun.message, at: lastRun.startedAt }
          : null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant={variant} onClick={run} loading={running} disabled={running}>
          {!running && Icon ? <Icon className="size-4" aria-hidden="true" /> : null}
          {running ? 'Running…' : label}
        </Button>
        {shown ? <RunStatusBadge status={shown.status} /> : <Badge tone="neutral">Never run</Badge>}
      </div>

      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}

      {shown?.message ? (
        <p
          className={cn(
            'text-xs leading-relaxed',
            shown.status === 'failed' ? 'text-danger' : 'text-muted-foreground',
          )}
          // Announce the outcome without moving focus.
          aria-live="polite"
        >
          {shown.message}
        </p>
      ) : null}

      {shown?.at ? (
        <p className="text-[11px] text-muted-foreground">
          Last run {formatRelative(shown.at)}
          {lastRun?.durationMs != null ? ` · ${(lastRun.durationMs / 1000).toFixed(1)}s` : ''}
        </p>
      ) : null}
    </div>
  );
}

export function RunStatusBadge({ status }: { status: IntegrationRunStatus }) {
  if (status === 'running') {
    return (
      <Badge tone="warning">
        <Loader2 className="size-3 animate-spin" aria-hidden="true" />
        Running
      </Badge>
    );
  }
  if (status === 'success') {
    return (
      <Badge tone="success">
        <CheckCircle2 className="size-3" aria-hidden="true" />
        Success
      </Badge>
    );
  }
  return (
    <Badge tone="danger">
      <AlertCircle className="size-3" aria-hidden="true" />
      Failed
    </Badge>
  );
}
