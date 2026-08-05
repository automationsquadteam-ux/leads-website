/**
 * Report leads that share an email address.
 *
 *   npm run leads:duplicates
 *   npm run leads:duplicates -- --merge      # keep the richest, archive the rest
 *
 * WHY THIS HAPPENS, despite leads.dedupe_key being UNIQUE:
 *
 * dedupe_key is computed ONCE, at import, from whatever the row had at the
 * time:
 *
 *     email:<address>    when there was a usable address
 *     site:<host+path>   when there was not
 *     name:<name>|<city> last resort
 *
 * A sheet row with no email gets `site:` or `name:`. If the address is filled
 * in later — upstream, or by hand in the CRM — the key is NOT recomputed,
 * because it is not in REFRESHABLE_FIELDS and nothing else touches it. So two
 * rows for one business can end up with different keys and the same address,
 * and the UNIQUE index is perfectly happy.
 *
 * Recomputing keys automatically would be worse: it would collide with the
 * surviving row and fail the whole sync, and merging is a judgement call about
 * which research and which drafts to keep. Hence a report, and an opt-in merge.
 *
 * --merge keeps the lead with the most filled-in fields, moves email logs,
 * replies, versions and activity onto it, and ARCHIVES the others. Nothing is
 * deleted.
 *
 * Uses the service-role key and bypasses RLS. Trusted machines only.
 */
import process from 'node:process';

import { config as loadEnv } from 'dotenv';

import { createServiceClient } from '../src/lib/supabase/service-client';
import type { Lead } from '../src/lib/supabase/database.types';

loadEnv({ path: '.env.local', quiet: true });
loadEnv({ quiet: true });

/**
 * How much real content a lead carries. The richest row wins a merge.
 *
 * `history` outranks everything: a row that already has send logs, a reply or a
 * confirmed verification is the one the outside world has interacted with.
 * Content can be copied across; a conversation cannot, and picking the other
 * row would mean relinking evidence for no reason.
 */
function score(lead: Lead, history = 0): number {
  const filled = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? 1 : 0);
  return (
    history * 100 +
    filled(lead.research_summary) * 3 +
    filled(lead.draft_email) * 3 +
    filled(lead.subject_line) +
    filled(lead.website_observations) +
    filled(lead.automation_opportunities) +
    filled(lead.ai_chatbot_opportunities) +
    filled(lead.website_improvement_opportunities) +
    filled(lead.personalization) +
    filled(lead.outreach_angle) +
    filled(lead.interesting_facts) +
    filled(lead.notes) +
    filled(lead.website) +
    filled(lead.phone) +
    (lead.sheet_row_number ? 1 : 0)
  );
}

async function main(): Promise<void> {
  const merge = process.argv.includes('--merge');
  const db = createServiceClient();

  const all: Lead[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from('leads')
      .select('*')
      .not('email', 'is', null)
      .order('id', { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    all.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }

  const byEmail = new Map<string, Lead[]>();
  for (const lead of all) {
    if (!lead.email) continue;
    const key = lead.email.trim().toLowerCase();
    byEmail.set(key, [...(byEmail.get(key) ?? []), lead]);
  }

  const dupes = [...byEmail.entries()].filter(([, rows]) => rows.length > 1);
  const line = '─'.repeat(72);

  console.log(`\n${line}`);
  console.log(`  Leads sharing an email address${merge ? '  (MERGING)' : ''}`);
  console.log(line);
  console.log(`  Leads with an address   ${all.length}`);
  console.log(`  Duplicated addresses    ${dupes.length}`);
  console.log(`  Extra rows involved     ${dupes.reduce((n, [, r]) => n + r.length - 1, 0)}`);
  console.log(line);

  if (dupes.length === 0) {
    console.log('\n  No duplicates. Nothing to do.\n');
    return;
  }

  for (const [email, rows] of dupes) {
    // Gather the evidence BEFORE ranking, so the survivor is chosen on it
    // rather than on field counts alone.
    const detail = new Map<string, { logs: number; replied: boolean; verified: boolean; stage: string; verif: string }>();

    for (const lead of rows) {
      const [{ count: logs }, { count: replies }, { data: p }] = await Promise.all([
        db.from('email_logs').select('*', { count: 'exact', head: true }).eq('lead_id', lead.id),
        db.from('replies').select('*', { count: 'exact', head: true }).eq('lead_id', lead.id),
        db
          .from('lead_pipeline')
          .select('email_verification_status, current_stage, replied')
          .eq('lead_id', lead.id)
          .maybeSingle(),
      ]);

      detail.set(lead.id, {
        logs: logs ?? 0,
        replied: Boolean(p?.replied) || (replies ?? 0) > 0,
        verified: p?.email_verification_status === 'valid',
        stage: p?.current_stage ?? '?',
        verif: p?.email_verification_status ?? '?',
      });
    }

    const historyOf = (id: string) => {
      const d = detail.get(id);
      if (!d) return 0;
      return (d.logs > 0 ? 2 : 0) + (d.replied ? 3 : 0) + (d.verified ? 1 : 0);
    };

    const ranked = [...rows].sort(
      (a, b) => score(b, historyOf(b.id)) - score(a, historyOf(a.id)),
    );
    const keep = ranked[0]!;

    console.log(`\n  ${email}`);
    for (const lead of ranked) {
      const d = detail.get(lead.id)!;
      const logs = d.logs;
      const p = { current_stage: d.stage, email_verification_status: d.verif, replied: d.replied };

      const tag = lead.id === keep.id ? 'KEEP  ' : 'ARCHIVE';
      console.log(
        `    ${tag} ${lead.id.slice(0, 8)}  score=${String(score(lead, historyOf(lead.id))).padStart(4)}  ` +
          `status=${lead.status.padEnd(11)} stage=${p.current_stage.padEnd(16)} ` +
          `verif=${p.email_verification_status.padEnd(10)} logs=${logs}` +
          `${p.replied ? ' REPLIED' : ''}`,
      );
      console.log(`             key=${lead.dedupe_key.slice(0, 58)}`);
    }

    if (!merge) continue;

    const losers = ranked.slice(1);
    for (const loser of losers) {
      // Move the evidence onto the surviving lead before archiving.
      await db.from('email_logs').update({ lead_id: keep.id }).eq('lead_id', loser.id);
      await db.from('replies').update({ lead_id: keep.id }).eq('lead_id', loser.id);
      await db.from('lead_activity').update({ lead_id: keep.id }).eq('lead_id', loser.id);
      await db.from('inbound_messages').update({ lead_id: keep.id }).eq('lead_id', loser.id);

      // Versions carry a UNIQUE (lead_id, type, version_number), so moving them
      // would collide. The survivor already has its own drafts; the loser's stay
      // attached to the archived row, readable but out of the way.
      await db
        .from('leads')
        .update({
          status: 'archived',
          notes: `${loser.notes ? `${loser.notes}\n\n` : ''}Merged into ${keep.id} by leads:duplicates on ${new Date().toISOString().slice(0, 10)}.`,
        })
        .eq('id', loser.id);
    }

    console.log(`    -> merged ${losers.length} row(s) into ${keep.id.slice(0, 8)}`);
  }

  console.log(`\n${line}`);
  if (merge) {
    console.log('  Merged. Losing rows are ARCHIVED, not deleted, and say so in their notes.');
  } else {
    console.log('  Dry report. Re-run with --merge to move logs/replies onto the KEEP row');
    console.log('  and archive the others. Nothing is ever deleted.');
  }
  console.log(`${line}\n`);
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
