'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { assertAdmin } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { TEMPLATE_PLACEHOLDERS } from '@/lib/templates/placeholders';
import { PIPELINE_STAGES } from '@/lib/supabase/database.types';
import type { ActionResult } from './leads';

/**
 * This file carries 'use server', so it may export **async functions only**.
 *
 * Exporting anything else an array, an object, a plain constant makes Next
 * refuse to evaluate the module, which takes down every action in it and
 * surfaces to the user as a 500 on an unrelated-looking POST. That is exactly
 * what TEMPLATE_PLACEHOLDERS did before it moved to lib/templates/placeholders.
 */

/* -------------------------------------------------------------------------- */
/* Templates full CRUD                                                       */
/* -------------------------------------------------------------------------- */

const templateSchema = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(1, 'Name is required.').max(120),
  subject: z.string().trim().min(1, 'Subject is required.').max(300),
  body: z.string().trim().min(1, 'Body is required.').max(20000),
});

export async function saveTemplate(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  try {
    await assertAdmin();
  } catch {
    return { ok: false, message: 'You do not have permission to manage templates.' };
  }

  const raw = Object.fromEntries(formData);
  const parsed = templateSchema.safeParse({ ...raw, id: raw.id || undefined });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }

  const { id, ...values } = parsed.data;
  // Record which placeholders the body actually uses, so a future renderer can
  // validate a lead has the data before sending.
  const variables = TEMPLATE_PLACEHOLDERS.filter(
    (token) => values.body.includes(token) || values.subject.includes(token),
  ).map((token) => token.replace(/[{}]/g, ''));

  const supabase = await createClient();
  const { error } = id
    ? await supabase.from('templates').update({ ...values, variables }).eq('id', id)
    : await supabase.from('templates').insert({ ...values, variables });

  if (error) {
    const duplicate = error.code === '23505';
    return {
      ok: false,
      message: duplicate ? 'A template with that name already exists.' : error.message,
    };
  }

  revalidatePath('/templates');
  return { ok: true, message: id ? 'Template updated.' : 'Template created.' };
}

export async function deleteTemplate(id: string): Promise<ActionResult> {
  try {
    await assertAdmin();
  } catch {
    return { ok: false, message: 'You do not have permission to manage templates.' };
  }

  const supabase = await createClient();
  const { error } = await supabase.from('templates').delete().eq('id', id);
  if (error) return { ok: false, message: error.message };

  revalidatePath('/templates');
  return { ok: true, message: 'Template deleted.' };
}

/* -------------------------------------------------------------------------- */
/* Campaigns                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Start / pause / resume flip `campaigns.active`, which is real state the
 * future sending worker will read. Nothing is dispatched here no worker
 * exists yet.
 */
export async function setCampaignActive(id: string, active: boolean): Promise<ActionResult> {
  try {
    await assertAdmin();
  } catch {
    return { ok: false, message: 'You do not have permission to manage campaigns.' };
  }

  const supabase = await createClient();
  const { error } = await supabase.from('campaigns').update({ active }).eq('id', id);
  if (error) return { ok: false, message: error.message };

  revalidatePath('/campaigns');
  revalidatePath('/dashboard');
  return {
    ok: true,
    message: active
      ? 'Campaign marked active. No email will be sent until the sending worker is connected.'
      : 'Campaign paused.',
  };
}

/** Stop = deactivate and clear the schedule window. */
export async function stopCampaign(id: string): Promise<ActionResult> {
  try {
    await assertAdmin();
  } catch {
    return { ok: false, message: 'You do not have permission to manage campaigns.' };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from('campaigns')
    .update({ active: false, ends_at: new Date().toISOString() })
    .eq('id', id);
  if (error) return { ok: false, message: error.message };

  revalidatePath('/campaigns');
  return { ok: true, message: 'Campaign stopped.' };
}

const campaignSchema = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(1, 'Name is required.').max(120),
  description: z
    .string()
    .trim()
    .max(2000)
    .transform((v) => (v === '' ? null : v))
    .nullable(),
  daily_limit: z.coerce.number().int().min(0).max(10000),
  template_id: z
    .string()
    .trim()
    .transform((v) => (v === '' ? null : v))
    .nullable(),
});

export async function saveCampaign(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  try {
    await assertAdmin();
  } catch {
    return { ok: false, message: 'You do not have permission to manage campaigns.' };
  }

  const raw = Object.fromEntries(formData);
  const parsed = campaignSchema.safeParse({ ...raw, id: raw.id || undefined });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }

  const { id, ...values } = parsed.data;
  const supabase = await createClient();
  const { error } = id
    ? await supabase.from('campaigns').update(values).eq('id', id)
    : await supabase.from('campaigns').insert(values);

  if (error) {
    return {
      ok: false,
      message: error.code === '23505' ? 'A campaign with that name already exists.' : error.message,
    };
  }

  revalidatePath('/campaigns');
  return { ok: true, message: id ? 'Campaign updated.' : 'Campaign created.' };
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Writes a batch of settings keys. Values are stored as jsonb, so each field
 * declares how to coerce its form string.
 */
export async function updateSettings(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await assertAdmin();
  } catch {
    return { ok: false, message: 'You do not have permission to change settings.' };
  }

  const supabase = await createClient();
  const updates: Array<{ key: string; value: unknown }> = [];

  // Working hours are three inputs that compose into one jsonb object, so they
  // are assembled here rather than going through the typed-prefix path below.
  const whStart = formData.get('wh-start');
  const whEnd = formData.get('wh-end');
  const whTz = formData.get('wh-tz');
  if (typeof whStart === 'string' && typeof whEnd === 'string') {
    const time = /^\d{2}:\d{2}$/;
    if (!time.test(whStart) || !time.test(whEnd)) {
      return { ok: false, message: 'Working hours must be in HH:MM format.' };
    }
    if (whStart >= whEnd) {
      return { ok: false, message: 'Working hours end must be after the start time.' };
    }
    updates.push({
      key: 'sending.working_hours',
      value: {
        timezone: typeof whTz === 'string' && whTz.trim() !== '' ? whTz.trim() : 'UTC',
        start: whStart,
        end: whEnd,
        days: [1, 2, 3, 4, 5],
      },
    });
  }

  for (const [field, raw] of formData.entries()) {
    if (typeof raw !== 'string') continue;
    const [kind, ...keyParts] = field.split(':');
    const key = keyParts.join(':');
    if (!key) continue;

    if (kind === 'number') {
      const num = Number(raw);
      if (!Number.isFinite(num)) return { ok: false, message: `${key} must be a number.` };
      updates.push({ key, value: num });
    } else if (kind === 'bool') {
      updates.push({ key, value: raw === 'on' || raw === 'true' });
    } else if (kind === 'string') {
      updates.push({ key, value: raw });
    } else if (kind === 'json') {
      try {
        updates.push({ key, value: JSON.parse(raw) });
      } catch {
        return { ok: false, message: `${key} contains invalid JSON.` };
      }
    }
  }

  /*
   * Which pipeline stages may appear on the public page.
   *
   * Assembled from checkboxes rather than going through the typed-prefix loop
   * below, because an unticked checkbox is simply absent from FormData so a
   * loop over what was submitted can never turn a stage OFF. Reading the
   * explicit roster and keeping only what was ticked is the only way clearing
   * the last box actually clears it.
   */
  if (formData.has('public-stages-present')) {
    const allowed = new Set<string>(PIPELINE_STAGES);
    const chosen = formData
      .getAll('public-stage')
      .filter((v): v is string => typeof v === 'string' && allowed.has(v));
    updates.push({ key: 'public.lead_stages', value: chosen });
  }

  if (updates.length === 0) return { ok: false, message: 'Nothing to save.' };

  for (const update of updates) {
    const { error } = await supabase
      .from('settings')
      .update({ value: update.value as never })
      .eq('key', update.key);
    if (error) return { ok: false, message: `${update.key}: ${error.message}` };
  }

  revalidatePath('/settings');
  return { ok: true, message: `Saved ${updates.length} setting${updates.length === 1 ? '' : 's'}.` };
}
