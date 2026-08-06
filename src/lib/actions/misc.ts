'use server';

import { revalidatePath } from 'next/cache';

import { assertAdmin } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { PIPELINE_STAGES } from '@/lib/supabase/database.types';
import type { ActionResult } from './leads';

/**
 * This file carries 'use server', so it may export **async functions only**.
 *
 * Exporting anything else an array, an object, a plain constant makes Next
 * refuse to evaluate the module, which takes down every action in it and
 * surfaces to the user as a 500 on an unrelated-looking POST.
 *
 * The template and campaign CRUD that used to live above the settings actions is
 * gone with those tables: every lead had campaign_id = NULL, so the draft
 * generator never once found a template and fell through to its built-in default
 * on all 701 leads.
 */
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
    /*
     * Days come from the form. They used to be hardcoded to [1,2,3,4,5] here,
     * which meant the sending days could not be changed at all — and worse,
     * pressing Save on this page silently reverted whatever was in the database
     * back to Monday-Friday.
     *
     * `wh-days-present` is the marker that makes "none ticked" expressible: an
     * unchecked checkbox never appears in FormData, so without it an empty set
     * and a form that was not rendered look identical.
     */
    const days = formData.getAll('wh-day')
      .map((value) => Number(value))
      .filter((day) => Number.isInteger(day) && day >= 1 && day <= 7);

    if (formData.get('wh-days-present') !== null && days.length === 0) {
      return { ok: false, message: 'Pick at least one sending day, or nothing will ever go out.' };
    }

    updates.push({
      key: 'sending.working_hours',
      value: {
        timezone: typeof whTz === 'string' && whTz.trim() !== '' ? whTz.trim() : 'UTC',
        start: whStart,
        end: whEnd,
        days: days.length > 0 ? [...new Set(days)].sort((a, b) => a - b) : [1, 2, 3, 4, 5, 6, 7],
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
