'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useActionState } from 'react';
import { Megaphone, Pause, Play, Plus, Square } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { EmptyState } from '@/components/empty-state';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { saveCampaign, setCampaignActive, stopCampaign } from '@/lib/actions/misc';
import type { ActionResult } from '@/lib/actions/leads';
import type { CampaignRow } from '@/lib/data/misc';
import { formatNumber, formatPercent } from '@/lib/utils';

const initialState: ActionResult = { ok: false, message: '' };

export function CampaignsClient({
  campaigns,
  templates,
}: {
  campaigns: CampaignRow[];
  templates: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [editing, setEditing] = React.useState<CampaignRow | 'new' | null>(null);
  const [stopping, setStopping] = React.useState<CampaignRow | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  async function toggle(campaign: CampaignRow, active: boolean) {
    setBusy(campaign.id);
    try {
      const result = await setCampaignActive(campaign.id, active);
      toast(result.message, result.ok ? 'success' : 'error');
      if (result.ok) router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="mb-4 flex justify-end">
        <Button variant="primary" onClick={() => setEditing('new')}>
          <Plus className="size-4" aria-hidden="true" />
          New campaign
        </Button>
      </div>

      {campaigns.length === 0 ? (
        <Card>
          <EmptyState
            icon={Megaphone}
            title="No campaigns yet"
            description="A campaign groups leads and controls the daily sending limit."
            action={
              <Button variant="primary" onClick={() => setEditing('new')}>
                <Plus className="size-4" aria-hidden="true" />
                Create campaign
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {campaigns.map((campaign) => {
            const progress =
              campaign.leadsTotal > 0
                ? ((campaign.leadsTotal - campaign.leadsRemaining) / campaign.leadsTotal) * 100
                : 0;

            return (
              <Card key={campaign.id}>
                <CardContent className="space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-semibold">{campaign.name}</h3>
                      {campaign.description ? (
                        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                          {campaign.description}
                        </p>
                      ) : null}
                    </div>
                    <Badge tone={campaign.active ? 'success' : 'neutral'}>
                      {campaign.active ? 'Running' : 'Paused'}
                    </Badge>
                  </div>

                  <dl className="grid grid-cols-4 gap-2 text-center">
                    <Stat label="Daily limit" value={formatNumber(campaign.daily_limit)} />
                    <Stat label="Leads" value={formatNumber(campaign.leadsTotal)} />
                    <Stat label="Remaining" value={formatNumber(campaign.leadsRemaining)} />
                    <Stat label="Replies" value={formatNumber(campaign.replies)} />
                  </dl>

                  <div>
                    <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                      <span>Progress</span>
                      <span className="tabular">{formatPercent(progress, 0)}</span>
                    </div>
                    <div
                      className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                      role="progressbar"
                      aria-valuenow={Math.round(progress)}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label={`${campaign.name} progress`}
                    >
                      <div
                        className="h-full rounded-full bg-primary transition-[width] duration-300"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
                    {campaign.active ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={busy === campaign.id}
                        onClick={() => toggle(campaign, false)}
                      >
                        <Pause className="size-3.5" aria-hidden="true" />
                        Pause
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="primary"
                        loading={busy === campaign.id}
                        onClick={() => toggle(campaign, true)}
                      >
                        <Play className="size-3.5" aria-hidden="true" />
                        {campaign.leadsTotal > 0 && progress > 0 ? 'Resume' : 'Start'}
                      </Button>
                    )}
                    <Button size="sm" variant="secondary" onClick={() => setStopping(campaign)}>
                      <Square className="size-3.5" aria-hidden="true" />
                      Stop
                    </Button>
                    <div className="flex-1" />
                    <Button size="sm" variant="ghost" onClick={() => setEditing(campaign)}>
                      Edit
                    </Button>
                  </div>

                  {campaign.templateName ? (
                    <p className="text-[11px] text-muted-foreground">
                      Template: <span className="text-foreground">{campaign.templateName}</span>
                    </p>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {editing ? (
        <CampaignDialog
          campaign={editing === 'new' ? null : editing}
          templates={templates}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={stopping !== null}
        onOpenChange={(open) => !open && setStopping(null)}
        title={`Stop "${stopping?.name ?? ''}"?`}
        description="The campaign is deactivated and its end date is set to now. Leads and history are kept."
        confirmLabel="Stop campaign"
        destructive
        onConfirm={async () => {
          if (!stopping) return;
          const result = await stopCampaign(stopping.id);
          toast(result.message, result.ok ? 'success' : 'error');
          if (result.ok) router.refresh();
        }}
      />
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-muted/40 px-1 py-1.5">
      <dt className="text-[10px] text-muted-foreground">{label}</dt>
      <dd className="tabular text-sm font-semibold">{value}</dd>
    </div>
  );
}

function CampaignDialog({
  campaign,
  templates,
  onClose,
  onSaved,
}: {
  campaign: CampaignRow | null;
  templates: Array<{ id: string; name: string }>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [state, formAction, pending] = useActionState(saveCampaign, initialState);

  React.useEffect(() => {
    if (!state.message) return;
    toast(state.message, state.ok ? 'success' : 'error');
    if (state.ok) onSaved();
  }, [state, toast, onSaved]);

  return (
    <Dialog open onClose={onClose} title={campaign ? 'Edit campaign' : 'New campaign'}>
      <form action={formAction} className="space-y-4">
        {campaign ? <input type="hidden" name="id" value={campaign.id} /> : null}

        <Field label="Name" htmlFor="campaign-name" required>
          <Input id="campaign-name" name="name" defaultValue={campaign?.name ?? ''} required maxLength={120} />
        </Field>

        <Field label="Description" htmlFor="campaign-description">
          <Textarea
            id="campaign-description"
            name="description"
            defaultValue={campaign?.description ?? ''}
            rows={3}
          />
        </Field>

        <Field
          label="Daily limit"
          htmlFor="campaign-limit"
          hint="Maximum emails this campaign may send per day."
        >
          <Input
            id="campaign-limit"
            name="daily_limit"
            type="number"
            inputMode="numeric"
            min={0}
            max={10000}
            defaultValue={campaign?.daily_limit ?? 50}
          />
        </Field>

        <Field label="Template" htmlFor="campaign-template">
          <Select id="campaign-template" name="template_id" defaultValue={campaign?.template_id ?? ''}>
            <option value="">No template</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </Select>
        </Field>

        {state.message && !state.ok ? (
          <p role="alert" className="text-xs text-danger">
            {state.message}
          </p>
        ) : null}

        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={pending}>
            {campaign ? 'Save changes' : 'Create campaign'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
