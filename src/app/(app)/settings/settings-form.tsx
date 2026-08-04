'use client';

import * as React from 'react';
import { useActionState } from 'react';
import { Save } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { updateSettings } from '@/lib/actions/misc';
import { STAGE_META } from '@/lib/pipeline/labels';
import { PIPELINE_STAGES } from '@/lib/supabase/database.types';
import type { ActionResult } from '@/lib/actions/leads';

const initialState: ActionResult = { ok: false, message: '' };

/**
 * Settings are stored as jsonb key/value pairs, so each input encodes its type
 * in the field name (`number:sending.daily_limit`). The action decodes that
 * prefix to coerce the value before writing.
 */
export function SettingsForm({ values }: { values: Record<string, unknown> }) {
  const { toast } = useToast();
  const [state, formAction, pending] = useActionState(updateSettings, initialState);

  React.useEffect(() => {
    if (state.message) toast(state.message, state.ok ? 'success' : 'error');
  }, [state, toast]);

  const str = (key: string, fallback = '') => {
    const value = values[key];
    return typeof value === 'string' ? value : fallback;
  };
  const num = (key: string, fallback = 0) => {
    const value = values[key];
    return typeof value === 'number' ? value : fallback;
  };
  const bool = (key: string, fallback: boolean) => {
    const value = values[key];
    return typeof value === 'boolean' ? value : fallback;
  };
  const provider = str('ai.provider', 'template') === 'ollama' ? 'ollama' : 'template';
  const showLeads = bool('public.show_leads', false);
  const publicStages = Array.isArray(values['public.lead_stages'])
    ? (values['public.lead_stages'] as string[])
    : [];
  const workingHours = (values['sending.working_hours'] ?? {}) as {
    timezone?: string;
    start?: string;
    end?: string;
  };

  return (
    <form action={formAction} className="space-y-4">
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Sending</CardTitle>
            <CardDescription>Pace and volume limits for outbound email.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Daily sending limit"
            htmlFor="daily-limit"
            hint="Maximum emails per day across all campaigns."
          >
            <Input
              id="daily-limit"
              name="number:sending.daily_limit"
              type="number"
              inputMode="numeric"
              min={0}
              max={10000}
              defaultValue={num('sending.daily_limit', 50)}
            />
          </Field>

          <Field
            label="Minimum gap between sends (seconds)"
            htmlFor="min-gap"
            hint="Spacing between consecutive emails."
          >
            <Input
              id="min-gap"
              name="number:sending.min_gap_seconds"
              type="number"
              inputMode="numeric"
              min={0}
              defaultValue={num('sending.min_gap_seconds', 90)}
            />
          </Field>

          <Field label="Working hours start" htmlFor="hours-start">
            <Input id="hours-start" name="wh-start" type="time" defaultValue={workingHours.start ?? '09:00'} />
          </Field>

          <Field label="Working hours end" htmlFor="hours-end">
            <Input id="hours-end" name="wh-end" type="time" defaultValue={workingHours.end ?? '17:00'} />
          </Field>

          <Field label="Timezone" htmlFor="hours-tz" className="sm:col-span-2">
            <Input id="hours-tz" name="wh-tz" defaultValue={workingHours.timezone ?? 'UTC'} placeholder="UTC" />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Email identity</CardTitle>
            <CardDescription>How outbound mail presents itself.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="From name" htmlFor="from-name">
            <Input id="from-name" name="string:email.default_from_name" defaultValue={str('email.default_from_name')} />
          </Field>

          <Field label="From address" htmlFor="from-address" hint="Must be a domain you control.">
            <Input
              id="from-address"
              name="string:email.default_from_address"
              type="email"
              defaultValue={str('email.default_from_address')}
            />
          </Field>

          <Field label="Default signature" htmlFor="signature" className="sm:col-span-2">
            <Textarea
              id="signature"
              name="string:email.default_signature"
              rows={4}
              defaultValue={str('email.default_signature')}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Draft generation</CardTitle>
            <CardDescription>
              What produces a draft when you press Regenerate, and what the scheduled sender uses to
              write a missing follow-up.
            </CardDescription>
          </div>
          <Badge tone={provider === 'ollama' ? 'violet' : 'neutral'}>
            {provider === 'ollama' ? 'Ollama' : 'Template'}
          </Badge>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Generator"
            htmlFor="ai-provider"
            className="sm:col-span-2"
            hint="Template composes drafts from the campaign template plus the lead research — deterministic, offline, always available. Ollama hands the same context to a local model."
          >
            <Select id="ai-provider" name="string:ai.provider" defaultValue={provider}>
              <option value="template">Template — deterministic, no model</option>
              <option value="ollama">Ollama — local model</option>
            </Select>
          </Field>

          <Field
            label="Ollama URL"
            htmlFor="ollama-url"
            hint="Ollama binds to localhost. Reachable only from the machine it runs on unless you set OLLAMA_HOST."
          >
            <Input
              id="ollama-url"
              name="string:ai.ollama_url"
              defaultValue={str('ai.ollama_url', 'http://localhost:11434')}
              placeholder="http://localhost:11434"
            />
          </Field>

          <Field label="Ollama model" htmlFor="ollama-model" hint="Must already be pulled: ollama pull <model>">
            <Input
              id="ollama-model"
              name="string:ai.ollama_model"
              defaultValue={str('ai.ollama_model', 'llama3.1:8b')}
              placeholder="llama3.1:8b"
            />
          </Field>

          <Field label="Max tokens" htmlFor="max-tokens">
            <Input
              id="max-tokens"
              name="number:ai.max_tokens"
              type="number"
              inputMode="numeric"
              min={256}
              max={32000}
              defaultValue={num('ai.max_tokens', 2048)}
            />
          </Field>

          <Field
            label="Generation timeout (seconds)"
            htmlFor="ai-timeout"
            hint="A cold model load can take a minute on the first request."
          >
            <Input
              id="ai-timeout"
              name="number:ai.timeout_seconds"
              type="number"
              inputMode="numeric"
              min={10}
              max={600}
              defaultValue={num('ai.timeout_seconds', 120)}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Outreach automation</CardTitle>
            <CardDescription>
              What the scheduled sender at <code className="font-mono text-[11px]">/api/cron/outreach</code>{' '}
              is allowed to do without a human.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Send follow-ups automatically"
            htmlFor="auto-followups"
            hint="Follow-ups go to people already contacted once."
          >
            <Select
              id="auto-followups"
              name="bool:outreach.auto_followups"
              defaultValue={bool('outreach.auto_followups', true) ? 'true' : 'false'}
            >
              <option value="true">Yes — send when due</option>
              <option value="false">No — I will send them</option>
            </Select>
          </Field>

          <Field
            label="Send initial emails automatically"
            htmlFor="auto-initial"
            hint="Off by default. A first touch that nobody read is how outreach becomes spam."
          >
            <Select
              id="auto-initial"
              name="bool:outreach.auto_send_initial"
              defaultValue={bool('outreach.auto_send_initial', false) ? 'true' : 'false'}
            >
              <option value="false">No — approved emails wait for a click</option>
              <option value="true">Yes — send approved emails automatically</option>
            </Select>
          </Field>

          <Field label="Follow-up 1 delay (days after the initial send)" htmlFor="fu1-delay">
            <Input
              id="fu1-delay"
              name="number:outreach.followup1_delay_days"
              type="number"
              inputMode="numeric"
              min={1}
              max={90}
              defaultValue={num('outreach.followup1_delay_days', 7)}
            />
          </Field>

          <Field label="Follow-up 2 delay (days after follow-up 1)" htmlFor="fu2-delay">
            <Input
              id="fu2-delay"
              name="number:outreach.followup2_delay_days"
              type="number"
              inputMode="numeric"
              min={1}
              max={90}
              defaultValue={num('outreach.followup2_delay_days', 3)}
            />
          </Field>

          <Field
            label="Only send to verified addresses"
            htmlFor="require-verified"
            hint="Applies to automatic initial sends."
          >
            <Select
              id="require-verified"
              name="bool:outreach.require_verified_email"
              defaultValue={bool('outreach.require_verified_email', true) ? 'true' : 'false'}
            >
              <option value="true">Yes — skip unverified</option>
              <option value="false">No — send anyway</option>
            </Select>
          </Field>

          <Field
            label="Follow-ups need approval"
            htmlFor="fu-approval"
            hint="On: an auto-generated follow-up waits for review instead of going out."
          >
            <Select
              id="fu-approval"
              name="bool:outreach.followup_requires_approval"
              defaultValue={bool('outreach.followup_requires_approval', false) ? 'true' : 'false'}
            >
              <option value="false">No — send when due</option>
              <option value="true">Yes — hold for review</option>
            </Select>
          </Field>

          <Field
            label="Maximum sends per run"
            htmlFor="max-per-run"
            hint="Also bounded by the daily limit above."
          >
            <Input
              id="max-per-run"
              name="number:outreach.max_sends_per_run"
              type="number"
              inputMode="numeric"
              min={1}
              max={500}
              defaultValue={num('outreach.max_sends_per_run', 25)}
            />
          </Field>

          <Field
            label="Global pause"
            htmlFor="sending-paused"
            hint="The kill switch. Nothing leaves the system while this is on."
          >
            <Select
              id="sending-paused"
              name="bool:sending.paused"
              defaultValue={bool('sending.paused', false) ? 'true' : 'false'}
            >
              <option value="false">Sending enabled</option>
              <option value="true">Paused — send nothing</option>
            </Select>
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Public page</CardTitle>
            <CardDescription>
              What anonymous visitors see at <code className="font-mono text-[11px]">/</code>.
              Aggregate counts are always published; naming individual businesses is not.
            </CardDescription>
          </div>
          <Badge tone={showLeads ? 'warning' : 'neutral'}>
            {showLeads ? `${publicStages.length} stage(s) shown` : 'Names hidden'}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field
            label="Publish a list of businesses"
            htmlFor="public-show-leads"
            hint="Even when on, only business name, city, country, industry and stage are published — never an address, phone number, research note or draft."
          >
            <Select
              id="public-show-leads"
              name="bool:public.show_leads"
              defaultValue={showLeads ? 'true' : 'false'}
            >
              <option value="false">No — aggregate counts only</option>
              <option value="true">Yes — publish the stages I pick below</option>
            </Select>
          </Field>

          <fieldset className="space-y-2">
            <legend className="text-xs font-medium text-muted-foreground">
              Stages that may be named publicly
            </legend>
            {/*
              A marker field so the action can tell "user submitted this form
              with everything unticked" from "this form was not on screen".
              Without it, clearing the last checkbox would be indistinguishable
              from no change and the stage would stay public.
            */}
            <input type="hidden" name="public-stages-present" value="1" />
            <div className="grid gap-1.5 sm:grid-cols-3">
              {PIPELINE_STAGES.map((stage) => (
                <label key={stage} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="public-stage"
                    value={stage}
                    defaultChecked={publicStages.includes(stage)}
                    className="size-4 cursor-pointer accent-primary"
                  />
                  {STAGE_META[stage].label}
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Nothing is published while this is empty, whatever the switch above says.
            </p>
          </fieldset>

          <Field label="Maximum businesses listed" htmlFor="public-lead-limit">
            <Input
              id="public-lead-limit"
              name="number:public.lead_limit"
              type="number"
              inputMode="numeric"
              min={1}
              max={500}
              defaultValue={num('public.lead_limit', 50)}
            />
          </Field>
        </CardContent>
      </Card>

      {/* Sticky save bar so the action is always reachable on a long form. */}
      <div className="sticky bottom-0 flex items-center justify-between gap-3 rounded-lg border border-border bg-surface/95 px-4 py-3 backdrop-blur-sm">
        <p className="text-xs text-muted-foreground">
          Saved immediately. The scheduled sender reads these on every run.
        </p>
        <Button type="submit" variant="primary" loading={pending}>
          <Save className="size-4" aria-hidden="true" />
          Save settings
        </Button>
      </div>
    </form>
  );
}

// SMTP, Gmail and Google Sheets credentials are configured in
// ./integrations-panel.tsx, which stores them encrypted. Nothing on this form
// is a secret.
