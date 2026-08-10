'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { assertAdmin } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { finishRun, startRun } from '@/lib/services/integration-runs';
import { getActiveProvider } from '@/lib/services/email';
import { sendTestEmail as sendTestEmailService } from '@/lib/services/email/send-lead-email';
import { verifyGenerator } from '@/lib/services/ai';
import { runOutreachCycle } from '@/lib/services/outreach/scheduler';
import { deleteSecret, setSecret, SECRET_KEYS, type SecretKey } from '@/lib/services/secrets';
import { getIntegrationConfig } from '@/lib/services/config';
import type { ActionResult } from './leads';

/**
 * Server actions for the integration control panel.
 *
 * Every one begins with assertAdmin(). The UI never talks to an SMTP server or
 * a model host directly it calls these, which call the services. That keeps
 * credentials on the server and gives one place to record run history.
 */

function refreshIntegrationViews() {
  revalidatePath('/settings');
  revalidatePath('/leads');
  revalidatePath('/dashboard');
}

/* -------------------------------------------------------------------------- */
/* Email provider                                                              */
/* -------------------------------------------------------------------------- */

export async function testEmailConnection(): Promise<ActionResult> {
  let session;
  try {
    session = await assertAdmin();
  } catch {
    return { ok: false, message: 'You do not have permission to test this connection.' };
  }

  const runId = await startRun('email', 'test_connection', session.user.id);

  try {
    const provider = await getActiveProvider();
    const result = await provider.verify();
    await finishRun(runId, result.ok ? 'success' : 'failed', result.message);
    revalidatePath('/settings');
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Provider is not configured.';
    await finishRun(runId, 'failed', message);
    revalidatePath('/settings');
    return { ok: false, message };
  }
}

export async function sendProviderTestEmail(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  let session;
  try {
    session = await assertAdmin();
  } catch {
    return { ok: false, message: 'You do not have permission to send email.' };
  }

  const parsed = z.email('Enter a valid recipient address.').safeParse(formData.get('recipient'));
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid recipient.' };
  }

  const runId = await startRun('email', 'send_test', session.user.id);
  const result = await sendTestEmailService(parsed.data);
  await finishRun(runId, result.ok ? 'success' : 'failed', result.message, {
    messageId: result.messageId,
  });

  revalidatePath('/settings');
  revalidatePath('/email-logs');
  return { ok: result.ok, message: result.message };
}

/* -------------------------------------------------------------------------- */
/* Draft generation                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Prove the configured generator works before anyone relies on it.
 *
 * For the template generator this always succeeds it needs nothing external,
 * which is exactly why it is the default. For Ollama it checks the server is up
 * and the configured model is actually pulled, which are the two things that go
 * wrong.
 */
export async function testDraftGenerator(): Promise<ActionResult> {
  let session;
  try {
    session = await assertAdmin();
  } catch {
    return { ok: false, message: 'You do not have permission to test this connection.' };
  }

  const runId = await startRun('ai', 'test_connection', session.user.id);
  const result = await verifyGenerator();
  await finishRun(runId, result.ok ? 'success' : 'failed', result.message, {
    provider: result.provider,
  });

  revalidatePath('/settings');
  return { ok: result.ok, message: `${result.provider}: ${result.message}` };
}

/* -------------------------------------------------------------------------- */
/* Outreach automation                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Run the scheduled sender by hand.
 *
 * The same function the cron endpoint calls, with `ignoreWorkingHours` set —
 * an admin pressing a button has decided that now is a good time, which is
 * exactly what the working-hours window exists to decide on their behalf when
 * they are not there.
 */
export async function runOutreachNow(dryRun: boolean): Promise<ActionResult> {
  let session;
  try {
    session = await assertAdmin();
  } catch {
    return { ok: false, message: 'You do not have permission to send email.' };
  }

  const runId = await startRun('outreach', dryRun ? 'dry_run' : 'send_due', session.user.id);
  const summary = await runOutreachCycle({ dryRun, ignoreWorkingHours: true });
  await finishRun(runId, summary.ok ? 'success' : 'failed', summary.message, {
    considered: summary.considered,
    sent: summary.sent,
    generated: summary.generated,
    skipped: summary.skipped,
    failed: summary.failed,
  });

  refreshIntegrationViews();
  revalidatePath('/email-logs');

  return {
    ok: summary.ok,
    message: summary.notes.length > 0 ? `${summary.message} ${summary.notes[0]}` : summary.message,
  };
}

/* -------------------------------------------------------------------------- */
/* Configuration + secrets                                                     */
/* -------------------------------------------------------------------------- */

const CONFIG_SCHEMA = z.object({
  'email.provider': z.enum(['smtp', 'gmail']).optional(),
  'smtp.host': z.string().trim().max(300).optional(),
  'smtp.port': z.coerce.number().int().min(1).max(65535).optional(),
  'smtp.username': z.string().trim().max(300).optional(),
  'email.gmail_user': z.string().trim().max(320).optional(),
  'email.test_recipient': z.string().trim().max(320).optional(),
  // Mirrored from the "Sending & content" form so the email card is
  // self-sufficient a relay cannot send without a from address.
  'email.default_from_address': z
    .string()
    .trim()
    .max(320)
    .refine((v) => v === '' || /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(v), {
      message: 'Enter a valid from address, or leave it blank.',
    })
    .optional(),
  'email.default_from_name': z.string().trim().max(120).optional(),
});

/** Persist the non-secret half of integration configuration. */
export async function saveIntegrationConfig(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await assertAdmin();
  } catch {
    return { ok: false, message: 'You do not have permission to change settings.' };
  }

  const raw = Object.fromEntries(
    [...formData.entries()].filter(([, value]) => typeof value === 'string'),
  );
  const parsed = CONFIG_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, message: `${issue?.path.join('.') ?? 'Field'}: ${issue?.message ?? 'invalid'}` };
  }

  // Checkboxes are absent from FormData when unticked, so they are read
  // explicitly rather than through the schema.
  const booleans: Record<string, boolean> = {
    'smtp.secure': formData.get('smtp.secure') === 'on',
  };

  const supabase = await createClient();
  const updates: Array<[string, unknown]> = [
    ...Object.entries(parsed.data).filter(([, value]) => value !== undefined),
    ...Object.entries(booleans),
  ];

  for (const [key, value] of updates) {
    const { error } = await supabase
      .from('settings')
      .update({ value: value as never })
      .eq('key', key);
    if (error) return { ok: false, message: `${key}: ${error.message}` };
  }

  refreshIntegrationViews();
  return { ok: true, message: `Saved ${updates.length} setting${updates.length === 1 ? '' : 's'}.` };
}

const SECRET_SET = new Set<string>(SECRET_KEYS);

/**
 * Store one credential, encrypted.
 *
 * Secrets are write-only from the UI's perspective: they go in here and are
 * never sent back to the browser only a "configured" flag and a masked hint.
 *
 * Takes plain arguments rather than FormData because the caller cannot be a
 * <form>: these fields render inside the configuration form on the settings
 * page, and nesting forms is invalid HTML.
 */
export async function saveSecret(key: string, value: string): Promise<ActionResult> {
  let session;
  try {
    session = await assertAdmin();
  } catch {
    return { ok: false, message: 'You do not have permission to change credentials.' };
  }

  if (!SECRET_SET.has(key)) return { ok: false, message: 'Unknown credential.' };
  if (value.trim() === '') return { ok: false, message: 'Enter a value, or use Remove to clear it.' };

  try {
    await setSecret(key as SecretKey, value, session.user.id);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Could not store the credential.' };
  }

  revalidatePath('/settings');
  return { ok: true, message: 'Credential saved and encrypted.' };
}

export async function removeSecret(key: string): Promise<ActionResult> {
  try {
    await assertAdmin();
  } catch {
    return { ok: false, message: 'You do not have permission to change credentials.' };
  }
  if (!SECRET_SET.has(key)) return { ok: false, message: 'Unknown credential.' };

  try {
    await deleteSecret(key as SecretKey);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Could not remove the credential.' };
  }

  revalidatePath('/settings');
  return { ok: true, message: 'Credential removed.' };
}

/** Read-back helper used by the settings page loader. */
export async function loadIntegrationConfig() {
  await assertAdmin();
  return getIntegrationConfig();
}
