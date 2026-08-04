import 'server-only';

import { createServiceClient } from '@/lib/supabase/service-client';

/**
 * Typed reader for the non-secret half of integration configuration.
 *
 * Values live in public.settings as jsonb. Reading through the service-role
 * client keeps callers independent of the request's RLS context every caller
 * has already done its own assertAdmin().
 */

export interface IntegrationConfig {
  sheets: {
    spreadsheetId: string;
    sheetName: string;
    headerRow: number;
    authMode: 'api_key' | 'service_account';
    updateExisting: boolean;
    /** Push CRM edits back to the sheet. Requires service-account auth. */
    writeBack: boolean;
  };
  email: {
    provider: 'smtp' | 'gmail';
    fromName: string;
    fromAddress: string;
    replyTo: string;
    signature: string;
    testRecipient: string;
    smtp: { host: string; port: number; secure: boolean; username: string };
    gmailUser: string;
  };
  ai: {
    /** Which generator produces drafts. See lib/services/ai/index.ts. */
    provider: 'template' | 'ollama';
    ollamaUrl: string;
    ollamaModel: string;
    temperature: number;
    maxTokens: number;
    timeoutSeconds: number;
  };
  outreach: {
    autoFollowups: boolean;
    /** Off by default a first touch should not fire without a human. */
    autoSendInitial: boolean;
    followup1DelayDays: number;
    followup2DelayDays: number;
    requireVerifiedEmail: boolean;
    followupRequiresApproval: boolean;
    maxSendsPerRun: number;
  };
  sending: {
    /** Global kill switch. Nothing leaves the system while this is true. */
    paused: boolean;
    dailyLimit: number;
    minGapSeconds: number;
    workingHours: { timezone: string; start: string; end: string; days: number[] };
  };
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}
function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export async function getIntegrationConfig(): Promise<IntegrationConfig> {
  const admin = createServiceClient();
  const { data } = await admin.from('settings').select('key, value');
  const map = new Map((data ?? []).map((row) => [row.key, row.value as unknown]));
  const get = (key: string) => map.get(key);

  const authMode = asString(get('sheets.auth_mode'), 'api_key');
  const provider = asString(get('email.provider'), 'smtp');
  const aiProvider = asString(get('ai.provider'), 'template');

  return {
    sheets: {
      spreadsheetId: asString(get('sheets.spreadsheet_id')),
      sheetName: asString(get('sheets.sheet_name'), 'Sheet1'),
      headerRow: asNumber(get('sheets.header_row'), 1),
      authMode: authMode === 'service_account' ? 'service_account' : 'api_key',
      updateExisting: asBoolean(get('sheets.update_existing'), true),
      writeBack: asBoolean(get('sheets.write_back'), false),
    },
    email: {
      provider: provider === 'gmail' ? 'gmail' : 'smtp',
      fromName: asString(get('email.default_from_name'), 'Leads CRM'),
      fromAddress: asString(get('email.default_from_address')),
      replyTo: asString(get('email.reply_to')),
      signature: asString(get('email.default_signature')),
      testRecipient: asString(get('email.test_recipient')),
      smtp: {
        host: asString(get('smtp.host')),
        port: asNumber(get('smtp.port'), 587),
        secure: asBoolean(get('smtp.secure'), false),
        username: asString(get('smtp.username')),
      },
      gmailUser: asString(get('email.gmail_user')),
    },
    ai: {
      // Anything other than an explicit 'ollama' falls back to the offline
      // template generator, so a typo in the setting degrades to a working
      // draft rather than to an unreachable HTTP call.
      provider: aiProvider === 'ollama' ? 'ollama' : 'template',
      ollamaUrl: asString(get('ai.ollama_url'), 'http://localhost:11434'),
      ollamaModel: asString(get('ai.ollama_model'), 'llama3.1:8b'),
      temperature: asNumber(get('ai.temperature'), 0.7),
      maxTokens: asNumber(get('ai.max_tokens'), 2048),
      timeoutSeconds: asNumber(get('ai.timeout_seconds'), 120),
    },
    outreach: {
      autoFollowups: asBoolean(get('outreach.auto_followups'), true),
      autoSendInitial: asBoolean(get('outreach.auto_send_initial'), false),
      followup1DelayDays: asNumber(get('outreach.followup1_delay_days'), 7),
      followup2DelayDays: asNumber(get('outreach.followup2_delay_days'), 3),
      requireVerifiedEmail: asBoolean(get('outreach.require_verified_email'), true),
      followupRequiresApproval: asBoolean(get('outreach.followup_requires_approval'), false),
      maxSendsPerRun: asNumber(get('outreach.max_sends_per_run'), 25),
    },
    sending: {
      paused: asBoolean(get('sending.paused'), false),
      dailyLimit: asNumber(get('sending.daily_limit'), 50),
      minGapSeconds: asNumber(get('sending.min_gap_seconds'), 90),
      workingHours: asWorkingHours(get('sending.working_hours')),
    },
  };
}

/**
 * `sending.working_hours` is a jsonb object written by the settings form.
 * Anything malformed falls back to a permissive 24/7 window rather than
 * blocking every send a bad settings row must not look like a broken sender.
 */
function asWorkingHours(value: unknown): IntegrationConfig['sending']['workingHours'] {
  const fallback = { timezone: 'UTC', start: '00:00', end: '23:59', days: [1, 2, 3, 4, 5, 6, 7] };
  if (typeof value !== 'object' || value === null) return fallback;

  const raw = value as Record<string, unknown>;
  const time = /^\d{2}:\d{2}$/;

  return {
    timezone: typeof raw.timezone === 'string' && raw.timezone.trim() !== '' ? raw.timezone : fallback.timezone,
    start: typeof raw.start === 'string' && time.test(raw.start) ? raw.start : fallback.start,
    end: typeof raw.end === 'string' && time.test(raw.end) ? raw.end : fallback.end,
    days:
      Array.isArray(raw.days) && raw.days.every((d) => typeof d === 'number')
        ? (raw.days as number[])
        : fallback.days,
  };
}
