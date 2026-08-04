'use client';

import * as React from 'react';
import { useActionState } from 'react';
import { Mail, RefreshCw, Send, Plug, Save, TableProperties, ShieldAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Field, Input, Select } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { TriggerButton, type LastRun } from '@/components/integrations/trigger-button';
import { SecretField } from '@/components/integrations/secret-field';
import {
  runGoogleSheetSync, saveIntegrationConfig, sendProviderTestEmail,
  testEmailConnection, testGoogleSheetsConnection,
  type SyncActionResult,
} from '@/lib/actions/integrations';
import type { ActionResult } from '@/lib/actions/leads';
import type { IntegrationConfig } from '@/lib/services/config';
import type { SecretStatus } from '@/lib/services/secrets';
import { formatNumber } from '@/lib/utils';

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
  const [syncResult, setSyncResult] = React.useState<SyncActionResult | null>(null);

  React.useEffect(() => {
    if (state.message) toast(state.message, state.ok ? 'success' : 'error');
  }, [state, toast]);

  const secretFor = (key: string) => secrets.find((s) => s.key === key);
  const [provider, setProvider] = React.useState(config.email.provider);
  const [authMode, setAuthMode] = React.useState(config.sheets.authMode);

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
        {/* Google Sheets                                                    */}
        {/* ---------------------------------------------------------------- */}
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Google Sheets</CardTitle>
              <CardDescription>
                The sheet is the ingestion layer. Syncing reads every row and upserts into Supabase.
              </CardDescription>
            </div>
            <Badge tone={config.sheets.spreadsheetId ? 'success' : 'neutral'}>
              {config.sheets.spreadsheetId ? 'Configured' : 'Not configured'}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field
              label="Spreadsheet ID"
              htmlFor="sheet-id"
              hint="The long id in the sheet URL, between /d/ and /edit."
            >
              <Input
                id="sheet-id"
                name="sheets.spreadsheet_id"
                defaultValue={config.sheets.spreadsheetId}
                placeholder="1AbC...xyz"
                className="font-mono text-xs"
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Tab name" htmlFor="sheet-name">
                <Input id="sheet-name" name="sheets.sheet_name" defaultValue={config.sheets.sheetName} />
              </Field>
              <Field label="Header row" htmlFor="sheet-header">
                <Input
                  id="sheet-header"
                  name="sheets.header_row"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={50}
                  defaultValue={config.sheets.headerRow}
                />
              </Field>
              <Field label="Auth mode" htmlFor="sheet-auth">
                <Select
                  id="sheet-auth"
                  name="sheets.auth_mode"
                  value={authMode}
                  onChange={(e) => setAuthMode(e.target.value as typeof authMode)}
                >
                  <option value="api_key">API key (public sheet)</option>
                  <option value="service_account">Service account (private sheet)</option>
                </Select>
              </Field>
            </div>

            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="sheets.update_existing"
                  defaultChecked={config.sheets.updateExisting}
                  className="size-4 cursor-pointer accent-primary"
                />
                Update leads that already exist
              </label>

              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  name="sheets.write_back"
                  defaultChecked={config.sheets.writeBack}
                  disabled={authMode !== 'service_account'}
                  className="mt-0.5 size-4 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
                />
                <span>
                  Write CRM edits back to the sheet
                  <span className="block text-xs text-muted-foreground">
                    {authMode === 'service_account'
                      ? 'Editing a lead updates its original row. The service account must have Editor access.'
                      : 'Requires service-account auth an API key is read-only.'}
                  </span>
                </span>
              </label>
            </div>

            {authMode === 'api_key' ? (
              <SecretField
                secretKey="sheets.api_key"
                label="Google API key"
                hint='Requires the sheet to be shared as "anyone with the link can view".'
                configured={secretFor('sheets.api_key')?.configured ?? false}
                maskedHint={secretFor('sheets.api_key')?.hint ?? null}
              />
            ) : (
              <SecretField
                secretKey="sheets.service_account_json"
                label="Service account JSON"
                hint="Paste the whole key file. Then share the sheet with that account's client_email."
                configured={secretFor('sheets.service_account_json')?.configured ?? false}
                maskedHint={secretFor('sheets.service_account_json')?.hint ?? null}
                multiline
                placeholder='{"type":"service_account","client_email":"...","private_key":"-----BEGIN PRIVATE KEY-----..."}'
              />
            )}
          </CardContent>
        </Card>

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
        <CardContent className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-2">
            <TriggerButton
              label="Sync Data"
              icon={RefreshCw}
              description="Reads every row, inserts new leads and updates changed ones."
              lastRun={lastRuns['google_sheets:sync_data'] ?? null}
              action={async () => {
                const outcome = await runGoogleSheetSync();
                setSyncResult(outcome);
                return { ok: outcome.ok, message: outcome.message };
              }}
            />
            <TriggerButton
              label="Test sheet connection"
              icon={TableProperties}
              variant="secondary"
              lastRun={lastRuns['google_sheets:test_connection'] ?? null}
              action={testGoogleSheetsConnection}
            />
          </div>

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

      {syncResult?.summary ? <SyncSummaryCard result={syncResult} /> : null}
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

function SyncSummaryCard({ result }: { result: SyncActionResult }) {
  const s = result.summary!;
  const cells: Array<[string, number]> = [
    ['Rows read', s.totalRows],
    ['Imported', s.imported],
    ['Updated', s.updated],
    ['Skipped', s.skipped],
    ['Invalid', s.invalid],
    ['Dupes in sheet', s.duplicatesInSheet],
  ];

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Last sync summary</CardTitle>
          <CardDescription>{(s.durationMs / 1000).toFixed(1)}s</CardDescription>
        </div>
        <Badge tone={result.ok ? 'success' : 'danger'}>{result.ok ? 'Success' : 'Failed'}</Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-6">
          {cells.map(([label, value]) => (
            <div key={label} className="rounded-md border border-border bg-muted/40 px-2 py-2 text-center">
              <dt className="text-[10px] text-muted-foreground">{label}</dt>
              <dd className="tabular text-lg font-semibold">{formatNumber(value)}</dd>
            </div>
          ))}
        </dl>

        {result.invalidRows.length > 0 ? (
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">
              Invalid rows (first {result.invalidRows.length})
            </p>
            <ul className="space-y-1">
              {result.invalidRows.map((row) => (
                <li key={row.rowNumber} className="text-xs text-danger">
                  <span className="tabular font-medium">Row {row.rowNumber}</span>
                  {row.businessName ? ` · ${row.businessName}` : ''} {row.reason}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {!result.ok ? (
          <p className="flex items-start gap-1.5 text-xs text-danger">
            <Mail className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
            {result.message}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
