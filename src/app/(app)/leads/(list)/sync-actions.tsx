'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { runGoogleSheetSync } from '@/lib/actions/integrations';

/**
 * Sync trigger on the leads toolbar.
 *
 * Calls the same server action the settings panel uses a shortcut to where
 * the result is visible, not a second implementation. Full run history and
 * configuration live under Settings → Integrations.
 */
export function LeadsSyncActions() {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = React.useState(false);

  async function sync() {
    setBusy(true);
    try {
      const outcome = await runGoogleSheetSync();
      toast(outcome.message, outcome.ok ? 'success' : 'error');
      if (outcome.ok) router.refresh();
    } catch {
      toast('Could not reach the server. Check your connection and try again.', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      variant="primary"
      onClick={sync}
      loading={busy}
      title="Pull rows from the configured Google Sheet into the CRM"
    >
      {!busy ? <RefreshCw className="size-4" aria-hidden="true" /> : null}
      Sync Data
    </Button>
  );
}
