'use client';

import * as React from 'react';
import { useActionState } from 'react';
import { Send, Plug, Save, ShieldAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Field, Input, Select } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { TriggerButton, type LastRun } from '@/components/integrations/trigger-button';
import { SecretField } from '@/components/integrations/secret-field';
import {
  saveIntegrationConfig, sendProviderTestEmail, testEmailConnection,
} from '@/lib/actions/integrations';
import type { ActionResult } from '@/lib/actions/leads';
import type { IntegrationConfig } from '@/lib/services/config';
import type { SecretStatus } from '@/lib/services/secrets';

const initialState: ActionResult = { ok: false, message: '' };

export function IntegrationsPanel({
  config,
  secrets,
  lastRuns,
  encryptionReady,
}: {
  config: IntegrationConfig;
  secrets: SecretStatus[];
  lastRuns: Record<string, LastRun | null>;
  encryptionReady: boolean;
}) {
  const { toast } = useToast();
  const [state, formAction, pending] = useActionState(saveIntegrationConfig, initialState);

  React.useEffect(() => {
    if (state.message) toast(state.message, state.ok ? 'success' : 'error');
  }, [state, toast]);

  const secretFor = (key: string) => secrets.find((s) => s.key === key);
  const [provider, setProvider] = React.useState(config.email.provider);

  return (
    <div className="space-y-4">
      {!encryptionReady ? (
        <div className="flex items-start gap-2.5 rounded-lg border border-warning/40 bg-warning-subtle px-4 py-3">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
          <div className="text-sm">
            <p className="font-medium text-warning">APP_ENCRYPTION_KEY is not set</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Credentials cannot be stored until it is. Generate one and add it to{' '}
              <code className="font-mono">.env.local</code>:
            </p>
            <pre className="mt-1.5 overflow-x-auto rounded border border-border bg-surface px-2 py-1.5 font-mono text-[11px]">
              node -e &quot;console.log(require(&apos;crypto&apos;).randomBytes(32).toString(&apos;base64&apos;))&quot;
            </pre>
          </div>
        </div>
      ) : null}

      <form action={formAction} className="space-y-4">
        {/* ---------------------------------------------------------------- */}
        {/* Email provider                                                   */}
        {/* ---------------------------------------------------------------- */}
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Email provider</CardTitle>
              <CardDescription>One provider is active at a time.</CardDescription>
            </div>
            <Badge tone="primary">{provider === 'gmail' ? 'Gmail' : 'SMTP'}</Badge>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label="Active provider" htmlFor="email-provider">
              <Select
                id="email-provider"
                name="email.provider"
                value={provider}
                onChange={(e) => setProvider(e.target.value as typeof provider)}
              >
                <option value="smtp">SMTP any relay</option>
                <option value="gmail">Gmail / Google Workspace</option>
              </Select>
            </Field>

            {provider === 'smtp' ? (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Host" htmlFor="smtp-host">
                    <Input id="smtp-host" name="smtp.host" defaultValue={config.email.smtp.host} placeholder="smtp.mailgun.org" />
                  </Field>
                  <Field label="Port" htmlFor="smtp-port" hint="587 for STARTTLS, 465 for implicit TLS.">
                    <Input
                      id="smtp-port"
                      name="smtp.port"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={65535}
                      defaultValue={config.email.smtp.port}
                    />
                  </Field>
                  <Field label="Username" htmlFor="smtp-user">
                    <Input id="smtp-user" name="smtp.username" defaultValue={config.email.smtp.username} autoComplete="off" />
                  </Field>
                  <label className="flex items-center gap-2 self-end pb-2 text-sm">
                    <input
                      type="checkbox"
                      name="smtp.secure"
                      defaultChecked={config.email.smtp.secure}
                      className="size-4 cursor-pointer accent-primary"
                    />
                    Implicit TLS (port 465)
                  </label>
                </div>

                <SecretField
                  secretKey="smtp.password"
                  label="SMTP password"
                  configured={secretFor('smtp.password')?.configured ?? false}
                  maskedHint={secretFor('smtp.password')?.hint ?? null}
                />
              </>
            ) : (
              <>
                <Field
                  label="Gmail address"
                  htmlFor="gmail-user"
                  hint="The account the App Password belongs to."
                >
                  <Input
                    id="gmail-user"
                    name="email.gmail_user"
                    type="email"
                    defaultValue={config.email.gmailUser}
                    placeholder="you@yourdomain.com"
                  />
                </Field>

                <SecretField
                  secretKey="gmail.app_password"
                  label="Gmail App Password"
                  hint="16 characters from myaccount.google.com → Security → App passwords. Requires 2-Step Verification."
                  configured={secretFor('gmail.app_password')?.configured ?? false}
                  maskedHint={secretFor('gmail.app_password')?.hint ?? null}
                />
              </>
            )}

            {/*
              From name and address live here as well as under "Sending &
              content". They are not optional decoration: SmtpProvider refuses
              to construct without a from address, so a relay configured
              perfectly still cannot send while this is blank. Putting it in the
              other section meant an operator could fill in every field on this
              card, press Test, and get an error about a field they could not
              see. Both inputs write the same settings key either way.
            */}
            <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
              <Field
                label="From address"
                htmlFor="from-address-int"
                required
                hint="Required to send. Must be a sender your relay has verified."
              >
                <Input
                  id="from-address-int"
                  name="email.default_from_address"
                  type="email"
                  defaultValue={config.email.fromAddress}
                  placeholder="send@yourdomain.com"
                  aria-describedby={config.email.fromAddress ? undefined : 'from-address-missing'}
                />
              </Field>

              <Field label="From name" htmlFor="from-name-int" hint="What recipients see as the sender.">
                <Input
                  id="from-name-int"
                  name="email.default_from_name"
                  defaultValue={config.email.fromName}
                  placeholder="Automation Squad"
                />
              </Field>

              {!config.email.fromAddress ? (
                <p
                  id="from-address-missing"
                  role="alert"
                  className="rounded-md border border-warning/30 bg-warning-subtle px-3 py-2 text-xs text-warning sm:col-span-2"
                >
                  No from address is set, so sending will fail with &quot;No from address
                  configured&quot; however correct the relay settings are. Set it above and save.
                </p>
              ) : null}
            </div>

            <Field label="Test recipient" htmlFor="test-recipient" hint="Default address for Send Test Email.">
              <Input
                id="test-recipient"
                name="email.test_recipient"
                type="email"
                defaultValue={config.email.testRecipient}
              />
            </Field>
          </CardContent>
        </Card>

        <div className="sticky bottom-0 flex items-center justify-between gap-3 rounded-lg border border-border bg-surface/95 px-4 py-3 backdrop-blur-sm">
          <p className="text-xs text-muted-foreground">
            Credentials are encrypted separately and saved with their own button.
          </p>
          <Button type="submit" variant="primary" loading={pending}>
            <Save className="size-4" aria-hidden="true" />
            Save configuration
          </Button>
        </div>
      </form>

      {/* ------------------------------------------------------------------ */}
      {/* Actions outside the config form so a click never submits it.      */}
      {/* ------------------------------------------------------------------ */}
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Actions</CardTitle>
            <CardDescription>Run integrations manually. Nothing polls on a timer.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid gap-6">
          <div className="space-y-2">
            <TriggerButton
              label="Test Connection"
              icon={Plug}
              description="Authenticates with the active provider without sending anything."
              lastRun={lastRuns['email:test_connection'] ?? null}
              variant="secondary"
              action={testEmailConnection}
            />
            <SendTestEmailForm defaultRecipient={config.email.testRecipient} />
          </div>
        </CardContent>
      </Card>

    </div>
  );
}

function SendTestEmailForm({ defaultRecipient }: { defaultRecipient: string }) {
  const { toast } = useToast();
  const [state, formAction, pending] = useActionState(sendProviderTestEmail, initialState);

  React.useEffect(() => {
    if (state.message) toast(state.message, state.ok ? 'success' : 'error');
  }, [state, toast]);

  return (
    <form action={formAction} className="space-y-2">
      <Field label="Send test email to" htmlFor="test-to">
        <Input
          id="test-to"
          name="recipient"
          type="email"
          required
          defaultValue={defaultRecipient}
          placeholder="you@example.com"
        />
      </Field>
      <Button type="submit" variant="secondary" loading={pending}>
        <Send className="size-4" aria-hidden="true" />
        Send Test Email
      </Button>
      {state.message ? (
        <p className={state.ok ? 'text-xs text-muted-foreground' : 'text-xs text-danger'} aria-live="polite">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
